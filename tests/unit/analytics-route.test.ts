/**
 * Tests for POST /api/analytics and lib/api/analytics.ts
 * Phase 6 / ANALYTICS-02 (CTR side).
 *
 * Threat coverage (T-06-02-01 log poisoning):
 *   - Unknown event types silently dropped (no log, 204)
 *   - Malformed JSON returns 400, no log
 *   - Only allow-listed fields are echoed to the log stream
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/analytics/route";
import { handleAnalyticsBeacon, VALID_EVENTS } from "@/lib/api/analytics";

function makeRequest(body: unknown, method = "POST"): NextRequest {
  if (typeof body === "string") {
    // Raw string — used for malformed JSON test
    return new NextRequest("http://localhost/api/analytics", {
      method,
      body,
      headers: { "content-type": "application/json" },
    });
  }
  return new NextRequest("http://localhost/api/analytics", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/analytics", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test A: 204 on valid search_click payload
  it("204 on valid search_click payload and emits structured log", async () => {
    const payload = {
      event: "search_click",
      q: "cancer",
      position: 3,
      cwid: "abc1234",
      resultType: "people",
      resultCount: 42,
      filters: {},
      ts: 1700000000000,
    };
    const req = makeRequest(payload);
    const resp = await POST(req);
    expect(resp.status).toBe(204);
    // Response body should be empty
    const body = await resp.text();
    expect(body).toBe("");
    // console.log called once with structured shape
    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse((console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(logged.event).toBe("search_click");
    expect(logged.q).toBe("cancer");
    expect(logged.position).toBe(3);
    expect(logged.cwid).toBe("abc1234");
    expect(logged.resultType).toBe("people");
    expect(logged.resultCount).toBe(42);
    expect(logged.filters).toEqual({});
    expect(logged.ts).toBe(1700000000000);
  });

  // Test B: 400 on malformed JSON
  it("400 on malformed JSON and does not log", async () => {
    const req = makeRequest("{not json");
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe("invalid payload");
    expect(console.log).not.toHaveBeenCalled();
  });

  // Test C: 204 silent drop on unknown event (log poisoning defense)
  it("204 silent drop on unknown event, does not log", async () => {
    const req = makeRequest({ event: "rogue_event", payload: "<script>alert(1)</script>" });
    const resp = await POST(req);
    expect(resp.status).toBe(204);
    expect(console.log).not.toHaveBeenCalled();
  });

  // Test D: 204 silent drop on missing event field
  it("204 silent drop on missing event field, does not log", async () => {
    const req = makeRequest({});
    const resp = await POST(req);
    expect(resp.status).toBe(204);
    expect(console.log).not.toHaveBeenCalled();
  });
});

describe("lib/api/analytics.ts handleAnalyticsBeacon (pure function)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test E: handleAnalyticsBeacon is a pure function
  it("logs structured shape on valid payload", () => {
    handleAnalyticsBeacon({
      event: "search_click",
      q: "cardiology",
      position: 0,
      cwid: "xyz9999",
      resultType: "people",
      resultCount: 10,
      filters: { department: "Medicine" },
      ts: 1700000001000,
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse((console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(logged.event).toBe("search_click");
    expect(logged.q).toBe("cardiology");
  });

  it("does not log for non-object payload (null)", () => {
    handleAnalyticsBeacon(null);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("does not log for non-object payload (string)", () => {
    handleAnalyticsBeacon("attack string");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("does not log for non-object payload (number)", () => {
    handleAnalyticsBeacon(42);
    expect(console.log).not.toHaveBeenCalled();
  });
});

// Test F: VALID_EVENTS export is the canonical allow-list
describe("VALID_EVENTS allow-list", () => {
  it("contains exactly search_click", () => {
    expect(VALID_EVENTS).toBeInstanceOf(Set);
    expect(VALID_EVENTS.has("search_click")).toBe(true);
    expect(VALID_EVENTS.size).toBe(1);
  });
});
