import type { SNSEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the AWS SDK before importing the handler so the module-scope client
// created lazily in getClient() resolves to our mock.
const sendMock = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({
    send: sendMock,
  })),
  GetSecretValueCommand: vi
    .fn()
    .mockImplementation((input: { SecretId: string }) => ({ input })),
}));

import { handler, __resetForTests } from "../index.js";

const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:665083158573:secret:scholars/staging/oncall/teams-webhook-url-AbCdEf";
const WEBHOOK_URL =
  "https://prod-99.eastus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=DEADBEEFCAFEBABE0123456789ABCDEF";
const WARN_SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:665083158573:secret:scholars/staging/oncall/teams-webhook-url-warn-ZzZzZz";
const WARN_URL =
  "https://prod-77.eastus.logic.azure.com:443/workflows/warn/triggers/manual/paths/invoke?api-version=2016-06-01&sig=WARNWARNWARN0123456789ABCDEF";
const WARN_TOPIC_ARN = "arn:aws:sns:us-east-1:0:sps-warn-staging";
const ETL_TOPIC_ARN = "arn:aws:sns:us-east-1:0:etl-failures-staging";

function snsEvent(
  messageOverride?: Record<string, unknown>,
  topicArn = "arn:aws:sns:us-east-1:0:t",
): SNSEvent {
  const message = JSON.stringify({
    AlarmName: "sps-alb-5xx-rate-staging",
    NewStateValue: "ALARM",
    NewStateReason: "Threshold Crossed",
    StateChangeTime: "2026-05-21T18:00:00.000+0000",
    Region: "us-east-1",
    ...messageOverride,
  });
  return {
    Records: [
      {
        EventSource: "aws:sns",
        EventVersion: "1.0",
        EventSubscriptionArn: "arn:aws:sns:us-east-1:0:t:s",
        Sns: {
          Type: "Notification",
          MessageId: "00000000-0000-0000-0000-000000000000",
          TopicArn: topicArn,
          Subject: "ALARM: sps-alb-5xx-rate-staging",
          Message: message,
          Timestamp: "2026-05-21T18:00:00.000Z",
          SignatureVersion: "1",
          Signature: "x",
          SigningCertUrl: "https://x",
          UnsubscribeUrl: "https://x",
          MessageAttributes: {},
        },
      },
    ],
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetForTests();
  sendMock.mockReset();
  process.env.TEAMS_WEBHOOK_SECRET_ARN = SECRET_ARN;
  delete process.env.TEAMS_WARN_WEBHOOK_SECRET_ARN;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  consoleLogSpy.mockRestore();
});

describe("oncall-relay handler", () => {
  it("cold-start fetches the secret then POSTs the Adaptive Card with application/json", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(snsEvent(), {} as never, () => undefined);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmdArg = sendMock.mock.calls[0]![0] as { input: { SecretId: string } };
    expect(cmdArg.input.SecretId).toBe(SECRET_ARN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe(WEBHOOK_URL);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(
      (init as { body: string }).body,
    ) as { type: string; attachments: unknown[] };
    expect(body.type).toBe("message");
    expect(body.attachments).toHaveLength(1);
  });

  it("ETL custom payload (no AlarmName) routes through the ETL card and logs the step as label", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    // AlarmName: undefined drops the key from the JSON, so the handler takes
    // the ETL branch. Real publisher: EtlStack NotifyEd SnsPublish.
    await handler(
      snsEvent({
        AlarmName: undefined,
        NewStateValue: undefined,
        NewStateReason: undefined,
        env: "staging",
        step: "Ed",
        stateMachine: "scholars-nightly-staging",
        error: "Connection timeout",
      }),
      {} as never,
      () => undefined,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as { body: string }).body,
    ) as { attachments: Array<{ content: { body: Array<{ text?: string }> } }> };
    expect(body.attachments[0]!.content.body[0]!.text).toBe(
      "\u{1F6A8} SPS ETL staging \u{2014} Ed",
    );
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    const delivered = logs.find((l) => l.includes('"outcome":"delivered"'));
    expect(delivered).toContain('"alarm":"Ed"');
  });

  it("warm invocation reuses cached URL: zero Secrets Manager calls on second hit", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValue(new Response("ok", { status: 202 }));

    await handler(snsEvent(), {} as never, () => undefined);
    await handler(snsEvent(), {} as never, () => undefined);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("HTTP 202 from Teams returns successfully and logs outcome=delivered", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(snsEvent(), {} as never, () => undefined);

    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    const delivered = logs.find((l) => l.includes('"outcome":"delivered"'));
    expect(delivered).toBeDefined();
    expect(delivered).toContain('"status":202');
  });

  it("HTTP 500 from Teams throws (so SNS retries) and logs outcome=upstream_error", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(
      new Response("server error", { status: 500 }),
    );

    await expect(
      handler(snsEvent(), {} as never, () => undefined),
    ).rejects.toThrow(/upstream_error_500/);

    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    const errLog = logs.find((l) => l.includes('"outcome":"upstream_error"'));
    expect(errLog).toBeDefined();
    expect(errLog).toContain('"status":500');
  });

  it("Secrets Manager returns no SecretString -> handler throws with empty_secret", async () => {
    sendMock.mockResolvedValueOnce({});

    await expect(
      handler(snsEvent(), {} as never, () => undefined),
    ).rejects.toThrow(/empty_secret/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("webhook URL never appears in any log call", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(snsEvent(), {} as never, () => undefined);

    for (const call of consoleLogSpy.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toContain(WEBHOOK_URL);
    }
  });

  it("warn-topic record posts to the warn webhook when configured and logs channel=warn", async () => {
    process.env.TEAMS_WARN_WEBHOOK_SECRET_ARN = WARN_SECRET_ARN;
    sendMock.mockImplementation(
      async (cmd: { input: { SecretId: string } }) =>
        cmd.input.SecretId === WARN_SECRET_ARN
          ? { SecretString: WARN_URL }
          : { SecretString: WEBHOOK_URL },
    );
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(snsEvent(undefined, WARN_TOPIC_ARN), {} as never, () => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(WARN_URL);
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    const delivered = logs.find((l) => l.includes('"outcome":"delivered"'));
    expect(delivered).toContain('"severity":"warn"');
    expect(delivered).toContain('"channel":"warn"');
  });

  it("warn-topic record falls back to the primary channel when the warn webhook is unset", async () => {
    // No TEAMS_WARN_WEBHOOK_SECRET_ARN configured (cleared in beforeEach).
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(snsEvent(undefined, WARN_TOPIC_ARN), {} as never, () => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(WEBHOOK_URL);
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    const delivered = logs.find((l) => l.includes('"outcome":"delivered"'));
    expect(delivered).toContain('"severity":"warn"');
    expect(delivered).toContain('"channel":"page"');
  });

  it("etl-failures topic is treated as the warn tier", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(
      snsEvent({ AlarmName: undefined, env: "staging", step: "Ed" }, ETL_TOPIC_ARN),
      {} as never,
      () => undefined,
    );

    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    const delivered = logs.find((l) => l.includes('"outcome":"delivered"'));
    expect(delivered).toContain('"severity":"warn"');
  });

  it("warn-secret read failure falls back to the primary channel (never drops the alert)", async () => {
    process.env.TEAMS_WARN_WEBHOOK_SECRET_ARN = WARN_SECRET_ARN;
    sendMock.mockImplementation(
      async (cmd: { input: { SecretId: string } }) => {
        if (cmd.input.SecretId === WARN_SECRET_ARN) {
          throw new Error("ResourceNotFoundException");
        }
        return { SecretString: WEBHOOK_URL };
      },
    );
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(snsEvent(undefined, WARN_TOPIC_ARN), {} as never, () => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(WEBHOOK_URL);
  });

  // ----------------------------------------------------------------------
  // Runtime failover — 2026-07-18 incident
  // ----------------------------------------------------------------------
  // The prod warn secret was provisioned with a placeholder: present, valid
  // https, hostname that does not resolve. Every prod P2 threw `fetch failed`
  // and was discarded for two days while the page tier looked healthy. The
  // "absent secret" fallback did not help — the secret was there.
  it("a warn webhook that fails at transport re-posts to the page channel", async () => {
    process.env.TEAMS_WARN_WEBHOOK_SECRET_ARN = WARN_SECRET_ARN;
    sendMock.mockImplementation(async (cmd: { input: { SecretId: string } }) => ({
      SecretString: cmd.input.SecretId === WARN_SECRET_ARN ? WARN_URL : WEBHOOK_URL,
    }));
    // Exactly the observed failure: undici's opaque wrapper over a DNS miss.
    const transport = new TypeError("fetch failed");
    (transport as { cause?: unknown }).cause = new Error("getaddrinfo ENOTFOUND");
    fetchMock
      .mockRejectedValueOnce(transport)
      .mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(snsEvent(undefined, WARN_TOPIC_ARN), {} as never, () => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe(WARN_URL);
    expect(fetchMock.mock.calls[1]![0]).toBe(WEBHOOK_URL);
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.find((l) => l.includes('"outcome":"transport_error"'))).toContain(
      '"channel":"warn"',
    );
    // The alert still lands, on the page channel.
    const delivered = logs.find((l) => l.includes('"outcome":"delivered"'));
    expect(delivered).toContain('"channel":"page"');
  });

  it("a warn webhook returning a non-2xx also falls back to the page channel", async () => {
    process.env.TEAMS_WARN_WEBHOOK_SECRET_ARN = WARN_SECRET_ARN;
    sendMock.mockImplementation(async (cmd: { input: { SecretId: string } }) => ({
      SecretString: cmd.input.SecretId === WARN_SECRET_ARN ? WARN_URL : WEBHOOK_URL,
    }));
    fetchMock
      .mockResolvedValueOnce(new Response("gone", { status: 404 }))
      .mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(snsEvent(undefined, WARN_TOPIC_ARN), {} as never, () => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(WEBHOOK_URL);
  });

  it("a failed warn channel is not retried for the rest of the container", async () => {
    process.env.TEAMS_WARN_WEBHOOK_SECRET_ARN = WARN_SECRET_ARN;
    sendMock.mockImplementation(async (cmd: { input: { SecretId: string } }) => ({
      SecretString: cmd.input.SecretId === WARN_SECRET_ARN ? WARN_URL : WEBHOOK_URL,
    }));
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed")) // warn, alert 1
      .mockResolvedValueOnce(new Response("ok", { status: 202 })) // page, alert 1
      .mockResolvedValueOnce(new Response("ok", { status: 202 })); // page, alert 2

    await handler(snsEvent(undefined, WARN_TOPIC_ARN), {} as never, () => undefined);
    await handler(snsEvent(undefined, WARN_TOPIC_ARN), {} as never, () => undefined);

    // 3 calls, not 4: the second alert skips the known-bad warn channel.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]![0]).toBe(WEBHOOK_URL);
  });

  it("throws only when EVERY channel fails, so SNS retries and the DLQ catches it", async () => {
    process.env.TEAMS_WARN_WEBHOOK_SECRET_ARN = WARN_SECRET_ARN;
    sendMock.mockImplementation(async (cmd: { input: { SecretId: string } }) => ({
      SecretString: cmd.input.SecretId === WARN_SECRET_ARN ? WARN_URL : WEBHOOK_URL,
    }));
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      handler(snsEvent(undefined, WARN_TOPIC_ARN), {} as never, () => undefined),
    ).rejects.toThrow("transport_error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a malformed warn secret is treated as absent, not used", async () => {
    process.env.TEAMS_WARN_WEBHOOK_SECRET_ARN = WARN_SECRET_ARN;
    for (const bad of ["   ", "not-a-url", "http://insecure.example/hook"]) {
      __resetForTests();
      fetchMock.mockReset();
      sendMock.mockImplementation(async (cmd: { input: { SecretId: string } }) => ({
        SecretString: cmd.input.SecretId === WARN_SECRET_ARN ? bad : WEBHOOK_URL,
      }));
      fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

      await handler(snsEvent(undefined, WARN_TOPIC_ARN), {} as never, () => undefined);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe(WEBHOOK_URL);
    }
  });

  it("page-tier record (generic topic) posts to the primary channel and logs channel=page", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(snsEvent(), {} as never, () => undefined);

    expect(fetchMock.mock.calls[0]![0]).toBe(WEBHOOK_URL);
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    const delivered = logs.find((l) => l.includes('"outcome":"delivered"'));
    expect(delivered).toContain('"severity":"page"');
    expect(delivered).toContain('"channel":"page"');
  });
});
