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

/** Pull the TextBlock text, FactSet facts, and actions out of a fetch() call's POST body. */
function cardFromFetch(call: unknown[]): {
  text: string;
  facts: Array<{ title: string; value: string }>;
  actions: Array<{ type: string; title: string; url: string }>;
} {
  const body = JSON.parse((call[1] as { body: string }).body) as {
    attachments: Array<{
      content: {
        body: Array<{
          type: string;
          text?: string;
          facts?: Array<{ title: string; value: string }>;
        }>;
        actions: Array<{ type: string; title: string; url: string }>;
      };
    }>;
  };
  const cardContent = body.attachments[0]!.content;
  const text = cardContent.body.find((b) => b.type === "TextBlock")?.text ?? "";
  const facts = cardContent.body.find((b) => b.type === "FactSet")?.facts ?? [];
  return { text, facts, actions: cardContent.actions };
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

  // A step-failure event only reaches etl-failures via the step's `Catch`,
  // which Step Functions runs ONLY after the `Retry` policy (MaxAttempts 2) is
  // exhausted -- so it is terminal by construction, never a transient blip.
  // These steps are tier:"continue", so the execution still reports SUCCEEDED
  // and this alert is the only signal that a source is dead. Measured
  // 2026-08-05: prod InfoEd failed all three attempts, published one message
  // here, was graded `warn`, and the grant import stayed dead for a day.
  it("a TERMINAL nightly step failure is a page, not a warn", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(
      snsEvent(
        {
          AlarmName: undefined,
          env: "prod",
          step: "Infoed",
          stateMachine: "scholars-nightly-prod",
          error: { Error: "States.TaskFailed" },
        },
        ETL_TOPIC_ARN,
      ),
      {} as never,
      () => undefined,
    );

    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    const delivered = logs.find((l) => l.includes('"outcome":"delivered"'));
    expect(delivered).toContain('"severity":"page"');
  });

  it("a WEEKLY step failure stays a warn — days of slack before it matters", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(
      snsEvent(
        {
          AlarmName: undefined,
          env: "prod",
          step: "News",
          stateMachine: "scholars-weekly-prod",
          error: { Error: "States.TaskFailed" },
        },
        ETL_TOPIC_ARN,
      ),
      {} as never,
      () => undefined,
    );

    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    const delivered = logs.find((l) => l.includes('"outcome":"delivered"'));
    expect(delivered).toContain('"severity":"warn"');
  });

  it("ETL card threads the handler-computed severity + the topic ARN's account id into an execution-specific link (#2304)", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(
      snsEvent(
        {
          AlarmName: undefined,
          env: "prod",
          step: "Infoed",
          stateMachine: "scholars-nightly-prod",
          execution: "abc-123",
          error: { Error: "States.TaskFailed" },
        },
        ETL_TOPIC_ARN, // "arn:aws:sns:us-east-1:0:etl-failures-staging" -> account id "0"
      ),
      {} as never,
      () => undefined,
    );

    const { text, facts, actions } = cardFromFetch(fetchMock.mock.calls[0]!);
    // Terminal nightly step failure -> severity refined to "page".
    expect(text).toBe("\u{1F6A8} SPS ETL prod \u{2014} Infoed");
    expect(facts.find((f) => f.title === "Severity")?.value).toBe("P1 (page)");
    expect(actions[0]!.url).toBe(
      "https://us-east-1.console.aws.amazon.com/states/v2/home?region=us-east-1#/executions/details/arn:aws:states:us-east-1:0:execution:scholars-nightly-prod:abc-123",
    );
  });

  it("ETL card leads with the warning glyph and renders a Severity fact for a warn-tier event", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(
      snsEvent(
        {
          AlarmName: undefined,
          env: "prod",
          step: "News",
          stateMachine: "scholars-weekly-prod", // weekly stays warn (days of slack)
          execution: "def-456",
          error: { Error: "States.TaskFailed" },
        },
        ETL_TOPIC_ARN,
      ),
      {} as never,
      () => undefined,
    );

    const { text, facts, actions } = cardFromFetch(fetchMock.mock.calls[0]!);
    expect(text).toBe("\u{26A0}\u{FE0F} SPS ETL prod \u{2014} News");
    expect(facts.find((f) => f.title === "Severity")?.value).toBe("P2 (warn)");
    // Execution link still fires regardless of severity tier.
    expect(actions[0]!.url).toContain("/executions/details/");
  });

  it("a malformed TopicArn (too few segments) degrades to no account id -- ETL card falls back to the state-machine-list URL, not a throw", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(
      snsEvent(
        {
          AlarmName: undefined,
          env: "prod",
          step: "Infoed",
          stateMachine: "scholars-nightly-prod",
          execution: "abc-123",
          error: { Error: "States.TaskFailed" },
        },
        "arn:aws:sns:us-east-1", // malformed: no account id / topic name segments
      ),
      {} as never,
      () => undefined,
    );

    const { actions } = cardFromFetch(fetchMock.mock.calls[0]!);
    expect(actions[0]!.url).toBe(
      "https://us-east-1.console.aws.amazon.com/states/home?region=us-east-1#/statemachines",
    );
    expect(actions[0]!.url).not.toContain("/executions/details/");
  });

  it("an approval-gate event on the same topic stays a warn (no step/error)", async () => {
    sendMock.mockResolvedValueOnce({ SecretString: WEBHOOK_URL });
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 202 }));

    await handler(
      snsEvent(
        {
          AlarmName: undefined,
          env: "prod",
          action: "approval-required",
          stateMachine: "scholars-nightly-prod",
        },
        ETL_TOPIC_ARN,
      ),
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
