import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashSessionId,
  logAutocompleteShown,
  type SuggestShownEvent,
} from "@/lib/api/suggest-log";

const baseEvent: SuggestShownEvent = {
  query: "cardio",
  resultCount: 7,
  latencyMs: 42,
  sessionId: "abc123def456",
  userAgent: "Mozilla/5.0",
};

describe("hashSessionId", () => {
  it("is deterministic for the same raw session id", () => {
    expect(hashSessionId("uuid-1")).toBe(hashSessionId("uuid-1"));
  });

  it("yields different hashes for different raw session ids", () => {
    expect(hashSessionId("uuid-1")).not.toBe(hashSessionId("uuid-2"));
  });

  it("returns a 16-char hex string", () => {
    expect(hashSessionId("uuid-1")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("logAutocompleteShown", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits a JSON line with the expected fields for a valid event", () => {
    const ok = logAutocompleteShown(baseEvent);
    expect(ok).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload).toMatchObject({
      event: "autocomplete_shown",
      query: "cardio",
      resultCount: 7,
      latencyMs: 42,
      sessionId: "abc123def456",
    });
    expect(payload.tsUtc).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("drops queries shorter than 3 chars (trimmed)", () => {
    expect(logAutocompleteShown({ ...baseEvent, query: "ca" })).toBe(false);
    expect(logAutocompleteShown({ ...baseEvent, query: "  c " })).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logs at exactly 3 chars", () => {
    expect(logAutocompleteShown({ ...baseEvent, query: "car" })).toBe(true);
  });

  it("drops requests from bot user agents", () => {
    const bots = [
      "Googlebot/2.1 (+http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0)",
      "Pingdom.com_bot_version_1.4",
      "UptimeRobot/2.0",
      "Datadog Agent/7.0",
      "StatusCake_Pagespeed_Indev",
      "Mozilla/5.0 (compatible; YandexBot/3.0)",
    ];
    for (const ua of bots) {
      expect(logAutocompleteShown({ ...baseEvent, userAgent: ua })).toBe(false);
    }
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("logs when user agent is null (e.g., non-browser test traffic)", () => {
    expect(logAutocompleteShown({ ...baseEvent, userAgent: null })).toBe(true);
  });
});
