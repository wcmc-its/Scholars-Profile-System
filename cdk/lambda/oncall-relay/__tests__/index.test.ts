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

function snsEvent(messageOverride?: Record<string, unknown>): SNSEvent {
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
          TopicArn: "arn:aws:sns:us-east-1:0:t",
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
});
