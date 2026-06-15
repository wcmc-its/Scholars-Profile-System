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
    cachedWarnWebhookUrl =
      out.SecretString !== undefined && out.SecretString.length > 0
        ? out.SecretString
        : undefined;
  } catch {
    // ResourceNotFound (secret not provisioned yet) or any other read failure:
    // fall back to the primary channel. Never let the warn lookup drop a P2.
    cachedWarnWebhookUrl = undefined;
  }
  return cachedWarnWebhookUrl;
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

    // P2/warn posts to the dedicated warn channel; if that webhook is not
    // configured it falls back to the primary channel so nothing is dropped.
    // P1 always posts to the primary channel.
    const warnUrl = severity === "warn" ? await getWarnWebhookUrl() : undefined;
    const channel = warnUrl !== undefined ? "warn" : "page";
    const url = warnUrl ?? (await getWebhookUrl());

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
      continue;
    }

    logOutcome(label, "upstream_error", {
      status: response.status,
      severity,
      channel,
    });
    // Throw so SNS retries the invocation and the Errors metric ticks.
    throw new Error(`upstream_error_${response.status}`);
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
