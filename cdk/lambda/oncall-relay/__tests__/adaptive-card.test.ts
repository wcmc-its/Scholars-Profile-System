import { describe, expect, it } from "vitest";
import {
  buildAdaptiveCard,
  buildEtlCard,
  isCloudWatchAlarmPayload,
  type CloudWatchAlarmPayload,
} from "../adaptive-card.js";

interface CardContent {
  $schema: string;
  type: string;
  version: string;
  body: Array<{
    type: string;
    text?: string;
    facts?: Array<{ title: string; value: string }>;
  }>;
  actions: Array<{ type: string; title: string; url: string }>;
}

function content(envelope: ReturnType<typeof buildAdaptiveCard>): CardContent {
  return envelope.attachments[0]!.content as unknown as CardContent;
}

function fact(c: CardContent, title: string): string | undefined {
  const facts = c.body.find((b) => b.type === "FactSet")?.facts ?? [];
  return facts.find((f) => f.title === title)?.value;
}

function header(c: CardContent): string {
  const tb = c.body.find((b) => b.type === "TextBlock");
  return tb?.text ?? "";
}

/** The body TextBlock that carries the mirrored markdown action links. */
function bodyLinks(c: CardContent): string {
  const tb = c.body
    .filter((b) => b.type === "TextBlock")
    .find((b) => (b.text ?? "").includes("]("));
  return tb?.text ?? "";
}

describe("buildAdaptiveCard", () => {
  it("ALARM on sps-alb-5xx-rate-staging renders alarm emoji + verbatim reason + console URL", () => {
    const alarm: CloudWatchAlarmPayload = {
      AlarmName: "sps-alb-5xx-rate-staging",
      NewStateValue: "ALARM",
      NewStateReason:
        "Threshold Crossed: 1 datapoint [5.2] was greater than the threshold (1.0).",
      StateChangeTime: "2026-05-21T18:00:00.000+0000",
      Region: "us-east-1",
    };
    const c = content(buildAdaptiveCard(alarm));
    expect(header(c)).toBe("\u{1F6A8} sps-alb-5xx-rate-staging");
    expect(fact(c, "State")).toBe("ALARM");
    expect(fact(c, "Reason")).toBe(alarm.NewStateReason);
    expect(fact(c, "Region")).toBe("us-east-1");
    expect(c.actions[0]!.url).toContain(
      encodeURIComponent("sps-alb-5xx-rate-staging"),
    );
    expect(c.actions[0]!.url).toContain("us-east-1");
    expect(c.version).toBe("1.5");
  });

  it("OK on the same alarm renders the green-check emoji and verbatim reason", () => {
    const alarm: CloudWatchAlarmPayload = {
      AlarmName: "sps-alb-5xx-rate-staging",
      NewStateValue: "OK",
      NewStateReason:
        "Threshold Crossed: 1 datapoint [0.0] was not greater than the threshold (1.0).",
      Region: "us-east-1",
    };
    const c = content(buildAdaptiveCard(alarm));
    expect(header(c)).toBe("\u{2705} sps-alb-5xx-rate-staging");
    expect(fact(c, "State")).toBe("OK");
    expect(fact(c, "Reason")).toBe(alarm.NewStateReason);
  });

  it("INSUFFICIENT_DATA on sps-aurora-connections-prod renders the question-mark emoji", () => {
    const alarm: CloudWatchAlarmPayload = {
      AlarmName: "sps-aurora-connections-prod",
      NewStateValue: "INSUFFICIENT_DATA",
      NewStateReason: "Insufficient Data: 3 datapoints were unknown.",
      Region: "us-east-1",
    };
    const c = content(buildAdaptiveCard(alarm));
    expect(header(c)).toBe("\u{2753} sps-aurora-connections-prod");
    expect(fact(c, "State")).toBe("INSUFFICIENT_DATA");
    expect(fact(c, "Region")).toBe("us-east-1");
  });

  it("ALARM with a 2KB reason truncates to 1024 chars and appends ellipsis", () => {
    const longReason = "X".repeat(2048);
    const alarm: CloudWatchAlarmPayload = {
      AlarmName: "sps-edit-authz-denied-staging",
      NewStateValue: "ALARM",
      NewStateReason: longReason,
      Region: "us-east-1",
    };
    const c = content(buildAdaptiveCard(alarm));
    const reason = fact(c, "Reason")!;
    expect(reason.length).toBe(1024);
    expect(reason.endsWith("\u{2026}")).toBe(true);
    expect(reason.startsWith("X".repeat(1023))).toBe(true);
    expect(header(c)).toBe("\u{1F6A8} sps-edit-authz-denied-staging");
  });

  it("non-ASCII reason text round-trips verbatim through the JSON serializer", () => {
    const alarm: CloudWatchAlarmPayload = {
      AlarmName: "sps-alb-5xx-rate-staging",
      NewStateValue: "ALARM",
      NewStateReason: "Threshold Crossed: \u{2192} triggered",
      Region: "us-east-1",
    };
    const envelope = buildAdaptiveCard(alarm);
    const c = content(envelope);
    expect(fact(c, "Reason")).toBe("Threshold Crossed: \u{2192} triggered");
    const serialized = JSON.stringify(envelope);
    const reparsed = JSON.parse(serialized) as ReturnType<
      typeof buildAdaptiveCard
    >;
    expect(fact(content(reparsed), "Reason")).toBe(
      "Threshold Crossed: \u{2192} triggered",
    );
  });

  it("empty reason field renders the (no reason provided) placeholder", () => {
    const alarm: CloudWatchAlarmPayload = {
      AlarmName: "sps-alb-5xx-rate-staging",
      NewStateValue: "ALARM",
      NewStateReason: "",
      Region: "us-east-1",
    };
    const c = content(buildAdaptiveCard(alarm));
    expect(fact(c, "Reason")).toBe("(no reason provided)");
    expect(header(c)).toBe("\u{1F6A8} sps-alb-5xx-rate-staging");
  });

  it("renders AlarmDescription as a Description fact (the runbook pointer reaches Teams)", () => {
    const alarm: CloudWatchAlarmPayload = {
      AlarmName: "sps-aurora-cpu-prod",
      AlarmDescription:
        "Aurora cluster CPU > 80% sustained for 10m (prod). See docs/SLOs.md.",
      NewStateValue: "ALARM",
      NewStateReason: "Threshold Crossed",
      Region: "us-east-1",
    };
    const c = content(buildAdaptiveCard(alarm));
    expect(fact(c, "Description")).toBe(alarm.AlarmDescription);
  });

  it("omits the Description fact when AlarmDescription is absent", () => {
    const c = content(
      buildAdaptiveCard({
        AlarmName: "sps-aurora-cpu-prod",
        NewStateValue: "ALARM",
        Region: "us-east-1",
      }),
    );
    expect(fact(c, "Description")).toBeUndefined();
  });

  it("renders the severity tier as a fact when supplied (P1 page / P2 warn), omitted otherwise", () => {
    const base: CloudWatchAlarmPayload = {
      AlarmName: "sps-aurora-cpu-prod",
      NewStateValue: "ALARM",
      Region: "us-east-1",
    };
    expect(fact(content(buildAdaptiveCard(base, "warn")), "Severity")).toBe(
      "P2 (warn)",
    );
    expect(fact(content(buildAdaptiveCard(base, "page")), "Severity")).toBe(
      "P1 (page)",
    );
    expect(fact(content(buildAdaptiveCard(base)), "Severity")).toBeUndefined();
  });

  it("adds a reliability-dashboard action for a known env, keeping CloudWatch first", () => {
    const c = content(
      buildAdaptiveCard({
        AlarmName: "sps-aurora-cpu-staging",
        NewStateValue: "ALARM",
        Region: "us-east-1",
      }),
    );
    expect(c.actions[0]!.title).toBe("View in CloudWatch");
    expect(c.actions[1]!.url).toContain(
      "dashboards:name=sps-reliability-staging",
    );
  });

  it("P2/warn ALARM cards lead with the warning glyph; P1 keeps the alarm glyph", () => {
    const alarm: CloudWatchAlarmPayload = {
      AlarmName: "sps-aurora-cpu-prod",
      NewStateValue: "ALARM",
      Region: "us-east-1",
    };
    expect(header(content(buildAdaptiveCard(alarm, "warn")))).toBe(
      "\u{26A0}\u{FE0F} sps-aurora-cpu-prod",
    );
    expect(header(content(buildAdaptiveCard(alarm, "page")))).toBe(
      "\u{1F6A8} sps-aurora-cpu-prod",
    );
    // No severity arg keeps the state glyph (back-compat).
    expect(header(content(buildAdaptiveCard(alarm)))).toBe(
      "\u{1F6A8} sps-aurora-cpu-prod",
    );
  });

  it("omits the dashboard action when the env is not derivable from the alarm name", () => {
    const c = content(
      buildAdaptiveCard({
        AlarmName: "some-external-alarm",
        NewStateValue: "ALARM",
        Region: "us-east-1",
      }),
    );
    expect(c.actions).toHaveLength(1);
    expect(c.actions[0]!.title).toBe("View in CloudWatch");
  });

  it("mirrors every action as a body markdown link (works on the flow-bot delivery path where buttons are inert)", () => {
    const c = content(
      buildAdaptiveCard({
        AlarmName: "sps-aurora-connections-prod",
        NewStateValue: "ALARM",
        Region: "us-east-1",
      }),
    );
    const links = bodyLinks(c);
    expect(links).toContain(
      `[View in CloudWatch](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:alarm/${encodeURIComponent("sps-aurora-connections-prod")})`,
    );
    expect(links).toContain(
      "[View reliability dashboard](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=sps-reliability-prod)",
    );
    // one markdown link per action, no more, no fewer
    expect((links.match(/\]\(/g) ?? []).length).toBe(c.actions.length);
  });
});

describe("isCloudWatchAlarmPayload", () => {
  it("true only when a string AlarmName is present", () => {
    expect(isCloudWatchAlarmPayload({ AlarmName: "x", NewStateValue: "ALARM" })).toBe(true);
    expect(isCloudWatchAlarmPayload({ env: "staging", step: "Ed" })).toBe(false);
    expect(isCloudWatchAlarmPayload({ AlarmName: 7 })).toBe(false);
    expect(isCloudWatchAlarmPayload(null)).toBe(false);
    expect(isCloudWatchAlarmPayload("AlarmName")).toBe(false);
  });
});

describe("buildEtlCard", () => {
  it("per-step failure payload renders env + step + state machine + execution + error", () => {
    const c = content(
      buildEtlCard({
        env: "staging",
        step: "Ed",
        stateMachine: "scholars-nightly-staging",
        execution: "abc-123",
        error: { Error: "States.TaskFailed", Cause: "exit 1" },
      }),
    );
    expect(header(c)).toBe("\u{1F6A8} SPS ETL staging \u{2014} Ed");
    expect(fact(c, "Env")).toBe("staging");
    expect(fact(c, "Step")).toBe("Ed");
    expect(fact(c, "State machine")).toBe("scholars-nightly-staging");
    expect(fact(c, "Execution")).toBe("abc-123");
    expect(fact(c, "Error")).toContain("States.TaskFailed");
    expect(c.actions[0]!.url).toContain("states/home");
  });

  it("string error renders verbatim; missing optional fields are omitted", () => {
    const c = content(buildEtlCard({ env: "prod", step: "Reciter", error: "boom" }));
    expect(fact(c, "Error")).toBe("boom");
    expect(fact(c, "State machine")).toBeUndefined();
    expect(fact(c, "Execution")).toBeUndefined();
  });

  it("approval-gate payload (action, runbook, no error) renders the action as the step", () => {
    const c = content(
      buildEtlCard({
        env: "prod",
        action: "approve-annual-hierarchy",
        runbook: "docs/PRODUCTION_ADDENDUM.md",
      }),
    );
    expect(header(c)).toBe("\u{1F6A8} SPS ETL prod \u{2014} approve-annual-hierarchy");
    expect(fact(c, "Error")).toBe("(none)");
    expect(fact(c, "Runbook")).toBe("docs/PRODUCTION_ADDENDUM.md");
  });

  it("missing env/step fall back to placeholders", () => {
    const c = content(buildEtlCard({}));
    expect(header(c)).toBe("\u{1F6A8} SPS ETL (unknown) \u{2014} event");
    expect(fact(c, "Step")).toBe("event");
  });

  it("oversized error is truncated to 1024 chars with an ellipsis", () => {
    const c = content(buildEtlCard({ env: "staging", step: "Ed", error: "Y".repeat(2048) }));
    const err = fact(c, "Error")!;
    expect(err.length).toBe(1024);
    expect(err.endsWith("\u{2026}")).toBe(true);
  });

  it("mirrors the Step Functions action as a body markdown link", () => {
    const c = content(buildEtlCard({ env: "prod", step: "Reciter", error: "boom" }));
    expect(bodyLinks(c)).toContain("[View in Step Functions](");
    expect(bodyLinks(c)).toContain("states/home");
  });
});
