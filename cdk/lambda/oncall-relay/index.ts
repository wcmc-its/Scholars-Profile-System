import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { SNSEvent, SNSHandler } from "aws-lambda";
import {
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
 * Log a structured outcome line. The URL is never logged -- only the alarm
 * name + HTTP status + outcome class. Audited by an index.test.ts case.
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
  const url = await getWebhookUrl();

  for (const record of event.Records) {
    const raw = record.Sns.Message;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logOutcome("(unparseable)", "parse_error", {
        error: (err as Error).message,
      });
      throw err;
    }

    // Two payload shapes land on the topics this Lambda subscribes to:
    // CloudWatch alarm JSON (sps-alarms + the ETL status/cadence alarms) and
    // the EtlStack Step Functions custom payload (per-step failure / approval
    // gate on etl-failures). Discriminate on `AlarmName`.
    let card: ReturnType<typeof buildAdaptiveCard>;
    let label: string;
    if (isCloudWatchAlarmPayload(parsed)) {
      card = buildAdaptiveCard(parsed);
      label = parsed.AlarmName;
    } else {
      const evt = parsed as EtlEventPayload;
      card = buildEtlCard(evt);
      label = evt.step ?? evt.action ?? "etl-event";
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
    });

    if (response.status >= 200 && response.status < 300) {
      logOutcome(label, "delivered", { status: response.status });
      continue;
    }

    logOutcome(label, "upstream_error", { status: response.status });
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
}
