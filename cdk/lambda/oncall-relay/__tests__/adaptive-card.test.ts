import { describe, expect, it } from "vitest";
import {
  buildAdaptiveCard,
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
});
