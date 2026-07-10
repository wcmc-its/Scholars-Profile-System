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

  it("bounds unbounded user-controlled strings (T-06-02-01)", () => {
    const huge = "a".repeat(5000);
    handleAnalyticsBeacon({
      event: "search_click",
      q: huge,
      cwid: huge,
      filters: { department: huge },
    });
    const logged = JSON.parse(
      (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(logged.q.length).toBe(512);
    expect(logged.cwid.length).toBe(512);
    expect(logged.filters.department.length).toBe(512);
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
  it("contains the expected events", () => {
    expect(VALID_EVENTS).toBeInstanceOf(Set);
    expect(VALID_EVENTS.has("search_click")).toBe(true);
    expect(VALID_EVENTS.has("mentoring_copubs_open")).toBe(true);
    expect(VALID_EVENTS.has("person_popover_open")).toBe(true);
    expect(VALID_EVENTS.has("person_popover_action")).toBe(true);
    expect(VALID_EVENTS.has("spotlight_paper_click")).toBe(true);
    expect(VALID_EVENTS.has("search_popover_opened")).toBe(true);
    expect(VALID_EVENTS.has("search_popover_mesh_browser_clicked")).toBe(true);
    expect(VALID_EVENTS.has("home_methods_stat_click")).toBe(true);
    expect(VALID_EVENTS.has("home_method_category_click")).toBe(true);
    expect(VALID_EVENTS.has("home_methods_explore_all_click")).toBe(true);
    expect(VALID_EVENTS.has("search_nav_watchdog")).toBe(true);
    expect(VALID_EVENTS.has("search_mesh_restrict")).toBe(true);
    expect(VALID_EVENTS.size).toBe(12);
  });
});

describe("handleAnalyticsBeacon search_nav_watchdog (#1017)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs surface + n on a valid payload", () => {
    handleAnalyticsBeacon({
      event: "search_nav_watchdog",
      surface: "autocomplete_submit",
      n: 7000,
      ts: 1700000006000,
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(
      (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(logged.event).toBe("search_nav_watchdog");
    expect(logged.surface).toBe("autocomplete_submit");
    expect(logged.n).toBe(7000);
    expect(logged.ts).toBe(1700000006000);
  });

  it("nulls out a wrong-typed surface / n (T-06-02-01)", () => {
    handleAnalyticsBeacon({
      event: "search_nav_watchdog",
      surface: 42,
      n: "soon",
      ts: 1700000007000,
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(
      (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(logged.surface).toBeNull();
    expect(logged.n).toBeNull();
  });
});

describe("handleAnalyticsBeacon spotlight_paper_click (#343)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs PMID + slot + cycle ID on a valid payload", () => {
    handleAnalyticsBeacon({
      event: "spotlight_paper_click",
      pmid: "39123456",
      slot: 2,
      cycleId: "v2026-05-16",
      subtopicId: "sub_cardio",
      ts: 1700000002000,
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(
      (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(logged.event).toBe("spotlight_paper_click");
    expect(logged.pmid).toBe("39123456");
    expect(logged.slot).toBe(2);
    expect(logged.cycleId).toBe("v2026-05-16");
    expect(logged.subtopicId).toBe("sub_cardio");
    expect(logged.ts).toBe(1700000002000);
  });

  it("nulls out fields with wrong types (T-06-02-01)", () => {
    handleAnalyticsBeacon({
      event: "spotlight_paper_click",
      pmid: 39123456,
      slot: "2",
      cycleId: { v: "x" },
      subtopicId: ["sub"],
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(
      (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(logged.pmid).toBeNull();
    expect(logged.slot).toBeNull();
    expect(logged.cycleId).toBeNull();
    expect(logged.subtopicId).toBeNull();
  });
});

describe("handleAnalyticsBeacon mentoring_copubs_open", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs structured shape on valid payload", () => {
    handleAnalyticsBeacon({
      event: "mentoring_copubs_open",
      mentorCwid: "abc1234",
      menteeCwid: "xyz5678",
      n: 3,
      ts: 1700000001000,
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(
      (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(logged.event).toBe("mentoring_copubs_open");
    expect(logged.mentorCwid).toBe("abc1234");
    expect(logged.menteeCwid).toBe("xyz5678");
    expect(logged.n).toBe(3);
  });

  it("nulls out fields with wrong types (T-06-02-01)", () => {
    handleAnalyticsBeacon({
      event: "mentoring_copubs_open",
      mentorCwid: 42,
      menteeCwid: { x: "y" },
      n: "three",
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(
      (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(logged.mentorCwid).toBeNull();
    expect(logged.menteeCwid).toBeNull();
    expect(logged.n).toBeNull();
  });
});

describe("handleAnalyticsBeacon search_popover_* (#265)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs mode + descriptorId on search_popover_opened (mesh-expanded)", () => {
    handleAnalyticsBeacon({
      event: "search_popover_opened",
      q: "electronic health records",
      mode: "mesh-expanded",
      descriptorId: "D057286",
      ts: 1700000002000,
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(
      (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(logged.event).toBe("search_popover_opened");
    expect(logged.q).toBe("electronic health records");
    expect(logged.mode).toBe("mesh-expanded");
    expect(logged.descriptorId).toBe("D057286");
    expect(logged.ts).toBe(1700000002000);
  });

  it("permits a null descriptorId on free-text open without dropping the event", () => {
    handleAnalyticsBeacon({
      event: "search_popover_opened",
      q: "sprezzatura",
      mode: "free-text",
      descriptorId: null,
      ts: 1700000003000,
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(
      (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(logged.mode).toBe("free-text");
    expect(logged.descriptorId).toBeNull();
  });

  it("logs q + descriptorId on search_popover_mesh_browser_clicked", () => {
    handleAnalyticsBeacon({
      event: "search_popover_mesh_browser_clicked",
      q: "EHR",
      descriptorId: "D057286",
      ts: 1700000004000,
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(
      (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(logged.event).toBe("search_popover_mesh_browser_clicked");
    expect(logged.q).toBe("EHR");
    expect(logged.descriptorId).toBe("D057286");
  });

  it("nulls out wrong-typed mode / descriptorId (T-06-02-01)", () => {
    handleAnalyticsBeacon({
      event: "search_popover_opened",
      q: "cancer",
      mode: 42,
      descriptorId: { ui: "D000" },
      ts: 1700000005000,
    });
    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(
      (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(logged.mode).toBeNull();
    expect(logged.descriptorId).toBeNull();
  });
});
