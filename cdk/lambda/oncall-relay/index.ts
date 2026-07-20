import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { SNSEvent, SNSHandler } from "aws-lambda";
import {
  type AlertSeverity,
  buildAdaptiveCard,
  buildEtlCard,
  isCloudWatchAlarmPayload,
  type EtlEventPayload,
} from "./adaptive-card.js";

// Module-scope cache: warm container reuses one Secrets Manager fetch and
// one SDK client per process. Cache lifetime = container lifetime (<=15 min
// for the warm pool); rotation picks up on the next cold start.
let cachedWebhookUrl: string | undefined;
let cachedClient: SecretsManagerClient | undefined;

// The P2 "warn" channel webhook is resolved separately and lazily.
// `warnWebhookResolved` distinguishes "not yet fetched" from "fetched and the
// secret is absent" so the lookup runs at most once per container even when
// the warn channel is unprovisioned. A missing/unreadable warn secret degrades
// to the primary channel (see getWarnWebhookUrl) -- the warn tier is
// best-effort and must never drop an alert.
let cachedWarnWebhookUrl: string | undefined;
let warnWebhookResolved = false;

function getClient(): SecretsManagerClient {
  if (cachedClient === undefined) {
    cachedClient = new SecretsManagerClient({});
  }
  return cachedClient;
}

async function getWebhookUrl(): Promise<string> {
  if (cachedWebhookUrl !== undefined) return cachedWebhookUrl;
  const secretArn = process.env.TEAMS_WEBHOOK_SECRET_ARN;
  if (secretArn === undefined || secretArn.length === 0) {
    throw new Error("TEAMS_WEBHOOK_SECRET_ARN is not set");
  }
  const out = await getClient().send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (out.SecretString === undefined || out.SecretString.length === 0) {
    // Empty value defeats the read-back guard in docs/oncall.md; surface it
    // as an error so SNS retries and OncallRelayErrors fires.
    throw new Error("empty_secret");
  }
  cachedWebhookUrl = out.SecretString;
  return cachedWebhookUrl;
}

/**
 * Resolve the P2 "warn" channel webhook, or `undefined` if it is not
 * configured. Unlike the primary webhook this NEVER throws: the warn tier is
 * best-effort, so a missing secret (e.g. the second Teams channel has not been
 * provisioned yet) falls back to the primary channel rather than failing the
 * invocation and re-driving every P2 alert through SNS retries. The lookup is
 * memoised (including the absent case) -- at most one Secrets Manager call per
 * warm container.
 */
async function getWarnWebhookUrl(): Promise<string | undefined> {
  if (warnWebhookResolved) return cachedWarnWebhookUrl;
  warnWebhookResolved = true;
  const secretArn = process.env.TEAMS_WARN_WEBHOOK_SECRET_ARN;
  if (secretArn === undefined || secretArn.length === 0) {
    cachedWarnWebhookUrl = undefined;
    return undefined;
  }
  try {
    const out = await getClient().send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    cachedWarnWebhookUrl = usableWebhookUrl(out.SecretString);
  } catch {
    // ResourceNotFound (secret not provisioned yet) or any other read failure:
    // fall back to the primary channel. Never let the warn lookup drop a P2.
    cachedWarnWebhookUrl = undefined;
  }
  return cachedWarnWebhookUrl;
}

/**
 * A webhook secret is only usable if it is a non-empty absolute https URL.
 * Anything else is treated exactly like an absent secret, so the caller
 * degrades to the primary channel instead of throwing.
 *
 * Note what this does and does NOT catch. It rejects empty values, non-https
 * schemes, and unparseable junk. It did NOT catch the 2026-07-18 incident: the
 * prod warn secret held a *syntactically valid* https URL whose hostname was a
 * placeholder that does not resolve, so it parses cleanly and only fails at
 * connect time. That is why the runtime fallback in the handler -- not this
 * function -- is the load-bearing fix.
 */
function usableWebhookUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return new URL(trimmed).protocol === "https:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stop using the warn webhook for the rest of this container's life. Called
 * when a warn POST fails at runtime: the next P2 in the same warm container
 * goes straight to the page channel instead of paying another failed request
 * and another pair of retries. `warnWebhookResolved` stays true, so this does
 * not trigger a re-read; a genuinely fixed secret is picked up on the next
 * cold start, same as provisioning one.
 */
function demoteWarnWebhook(): void {
  cachedWarnWebhookUrl = undefined;
}

/**
 * Map the originating SNS topic to a severity tier. The P2/warn topics are the
 * dedicated `sps-warn-<env>` topic and the ETL `etl-failures-<env>` topic --
 * data-freshness, reconciler, and resource-pressure signals are "review this
 * morning", not "wake on-call". Everything else (the `sps-alarms-<env>` page
 * topic) is P1.
 */
function severityForRecord(topicArn: string): AlertSeverity {
  if (topicArn.includes(":sps-warn-")) return "warn";
  if (topicArn.includes(":etl-failures-")) return "warn";
  return "page";
}

/**
 * Log a structured outcome line. The URL is never logged -- only the alarm
 * name + HTTP status + outcome class + severity/channel. Audited by an
 * index.test.ts case.
 */
function logOutcome(
  alarmName: string,
  outcome: string,
  extra: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({
      event: "oncall_relay",
      alarm: alarmName,
      outcome,
      ts: new Date().toISOString(),
      ...extra,
    }),
  );
}

export const handler: SNSHandler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records) {
    const severity = severityForRecord(record.Sns.TopicArn);
    const raw = record.Sns.Message;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logOutcome("(unparseable)", "parse_error", {
        severity,
        error: (err as Error).message,
      });
      throw err;
    }

    // Two payload shapes land on the topics this Lambda subscribes to:
    // CloudWatch alarm JSON (sps-alarms / sps-warn / the ETL status+cadence
    // alarms) and the EtlStack Step Functions custom payload (per-step failure
    // / approval gate on etl-failures). Discriminate on `AlarmName`.
    let card: ReturnType<typeof buildAdaptiveCard>;
    let label: string;
    if (isCloudWatchAlarmPayload(parsed)) {
      card = buildAdaptiveCard(parsed, severity);
      label = parsed.AlarmName;
    } else {
      const evt = parsed as EtlEventPayload;
      card = buildEtlCard(evt);
      label = evt.step ?? evt.action ?? "etl-event";
    }

    // Ordered delivery attempts. A P2 tries the dedicated warn channel first
    // and, if that FAILS AT RUNTIME, re-posts to the page channel rather than
    // being dropped. P1 only ever uses the page channel.
    //
    // The runtime fallback exists because the "absent secret" fallback above is
    // not enough. On 2026-07-18 the prod warn secret was provisioned with a
    // placeholder URL: present, well-formed, and pointing at a host that does
    // not resolve. Every prod P2 alert -- aurora, OpenSearch, authz, and the
    // ETL freshness cards -- threw `fetch failed` and was discarded for two
    // days while the page tier kept looking healthy, because a half-finished
    // provisioning step is indistinguishable from a working one until you
    // actually send. A P2 landing in the page channel is a nuisance; a P2
    // landing nowhere is an outage you learn about from someone else.
    //
    // The page URL is resolved lazily so a working warn channel never depends
    // on the page secret being readable.
    const warnUrl = severity === "warn" ? await getWarnWebhookUrl() : undefined;
    const attempts: Array<{
      channel: "warn" | "page";
      resolve: () => Promise<string>;
    }> = [];
    if (warnUrl !== undefined) {
      attempts.push({ channel: "warn", resolve: async () => warnUrl });
    }
    attempts.push({ channel: "page", resolve: getWebhookUrl });

    let delivered = false;
    let lastFailure = "no_attempt";
    for (const attempt of attempts) {
      const { channel } = attempt;
      // Resolving the URL is CONFIGURATION, not a delivery attempt, so it sits
      // outside the try: a missing or empty page secret must keep propagating
      // as its own specific error (`empty_secret`) instead of being flattened
      // into `transport_error` and losing the reason.
      const url = await attempt.resolve();
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(card),
        });
        if (response.status >= 200 && response.status < 300) {
          logOutcome(label, "delivered", {
            status: response.status,
            severity,
            channel,
          });
          delivered = true;
          break;
        }
        lastFailure = `upstream_error_${response.status}`;
        logOutcome(label, "upstream_error", {
          status: response.status,
          severity,
          channel,
        });
      } catch (err) {
        // A transport-level failure (DNS, TLS, connect) surfaces from fetch as
        // an opaque `TypeError: fetch failed`; the useful detail is in `cause`.
        lastFailure = "transport_error";
        logOutcome(label, "transport_error", {
          severity,
          channel,
          error: (err as Error).message,
          cause: String((err as { cause?: unknown }).cause ?? ""),
        });
      }
      // This channel just failed. If it was the warn channel, stop using it for
      // the rest of this container so the fallback is paid once, not per alert.
      if (channel === "warn") demoteWarnWebhook();
    }

    if (!delivered) {
      // Every channel failed -- throw so SNS retries, the Errors metric ticks,
      // and the event ultimately lands in the DLQ rather than vanishing.
      throw new Error(lastFailure);
    }
  }
};

// Test-only escape hatch — vitest resets module state between files but
// `index.test.ts` exercises cold-start vs warm-cache behavior in the same
// module load, so the warm-cache test needs a way to reset the cache
// without forcing a module reload.
export function __resetForTests(): void {
  cachedWebhookUrl = undefined;
  cachedClient = undefined;
  cachedWarnWebhookUrl = undefined;
  warnWebhookResolved = false;
}
