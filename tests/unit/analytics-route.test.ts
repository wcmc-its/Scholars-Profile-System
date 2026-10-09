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
    expect(VALID_EVENTS.has("biosketch_worksheet_copy")).toBe(true);
    expect(VALID_EVENTS.has("grant_rec_impression")).toBe(true);
    expect(VALID_EVENTS.has("grant_rec_details_open")).toBe(true);
    expect(VALID_EVENTS.has("grant_rec_outbound_click")).toBe(true);
    expect(VALID_EVENTS.has("grant_rec_sort")).toBe(true);
    expect(VALID_EVENTS.size).toBe(17);
  });
});

describe("handleAnalyticsBeacon grant_rec_* (#1609)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lastLog = () =>
    JSON.parse((console.log as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string);

  it("204s through the route and logs an impression with its bounded id list", async () => {
    const resp = await POST(
      makeRequest({
        event: "grant_rec_impression",
        cwid: "thc2015",
        surface: "self",
        mode: "fit",
        resultCount: 2,
        opportunityIds: ["NIH-PA-1", 42, "NSF-9"],
        ts: 1700000007000,
      }),
    );
    expect(resp.status).toBe(204);
    expect(lastLog()).toMatchObject({
      event: "grant_rec_impression",
      cwid: "thc2015",
      surface: "self",
      mode: "fit",
      resultCount: 2,
      // non-strings dropped (log-poisoning posture)
      opportunityIds: ["NIH-PA-1", "NSF-9"],
      opportunityId: null,
    });
  });

  it("caps the id list at 100 entries and each id at 512 chars", () => {
    handleAnalyticsBeacon({
      event: "grant_rec_impression",
      opportunityIds: [
        "x".repeat(2000),
        ...Array.from({ length: 300 }, (_, i) => `id${i}`),
      ],
    });
    const logged = lastLog();
    expect(logged.opportunityIds).toHaveLength(100);
    expect(logged.opportunityIds[0]).toHaveLength(512);
  });

  it("logs details-open / outbound-click with opportunityId + position, and sort with mode", () => {
    for (const event of ["grant_rec_details_open", "grant_rec_outbound_click"]) {
      handleAnalyticsBeacon({
        event,
        cwid: "thc2015",
        surface: "superuser",
        mode: "deadline",
        opportunityId: "NIH-PA-1",
        position: 3,
      });
      expect(lastLog()).toMatchObject({
        event,
        opportunityId: "NIH-PA-1",
        position: 3,
        surface: "superuser",
        opportunityIds: null,
      });
    }
    handleAnalyticsBeacon({ event: "grant_rec_sort", cwid: "thc2015", mode: "prestige" });
    expect(lastLog()).toMatchObject({ event: "grant_rec_sort", mode: "prestige" });
  });

  it("still drops unknown grant-rec-ish events", () => {
    handleAnalyticsBeacon({ event: "grant_rec_whatever", opportunityId: "x" });
    expect(console.log).not.toHaveBeenCalled();
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

// not_found beacon (NotFoundBeacon) — re-emitted via logNotFound / logVivoFourOhFour.
describe("handleAnalyticsBeacon — not_found", () => {
  let logs: Array<Record<string, unknown>>;

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(JSON.parse(line as string) as Record<string, unknown>);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid public not_found and emits the logNotFound shape only", () => {
    handleAnalyticsBeacon({
      event: "not_found",
      variant: "public",
      path: "/jane-doe",
      pattern: "profile",
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "not_found", path: "/jane-doe", pattern: "profile" });
    expect(Object.keys(logs[0]).sort()).toEqual(["event", "path", "pattern", "ts"]);
  });

  it("strips query string and hash from the path, and caps its length", () => {
    handleAnalyticsBeacon({ event: "not_found", path: "/a/b?email=x@y.z#frag", pattern: "other" });
    handleAnalyticsBeacon({ event: "not_found", path: "/c#x?y", pattern: "other" });
    handleAnalyticsBeacon({ event: "not_found", path: "/" + "z".repeat(2000), pattern: "other" });
    expect(logs.map((l) => l.path).slice(0, 2)).toEqual(["/a/b", "/c"]);
    expect((logs[2].path as string).length).toBe(512);
  });

  it("rejects a bad path or pattern (no log)", () => {
    handleAnalyticsBeacon({ event: "not_found", path: "relative", pattern: "other" });
    handleAnalyticsBeacon({ event: "not_found", path: "https://evil.example/x", pattern: "other" });
    handleAnalyticsBeacon({ event: "not_found", path: 42, pattern: "other" });
    handleAnalyticsBeacon({ event: "not_found", pattern: "other" });
    handleAnalyticsBeacon({ event: "not_found", path: "/x", pattern: "bogus" });
    handleAnalyticsBeacon({ event: "not_found", path: "/x" });
    expect(logs).toHaveLength(0);
  });

  it("root variant on a VIVO path ALSO emits vivo_404, exactly as the old root not-found did", () => {
    handleAnalyticsBeacon({
      event: "not_found",
      variant: "root",
      path: "/display/cwid-abc123",
      pattern: "vivo",
    });
    expect(logs.map((l) => l.event)).toEqual(["not_found", "vivo_404"]);
    expect(logs[1]).toMatchObject({ url: "/display/cwid-abc123" });
  });

  it("root variant on a non-VIVO path emits not_found only; public never emits vivo_404", () => {
    handleAnalyticsBeacon({ event: "not_found", variant: "root", path: "/nope", pattern: "other" });
    handleAnalyticsBeacon({
      event: "not_found",
      variant: "public",
      path: "/display/cwid-abc123",
      pattern: "other",
    });
    expect(logs.map((l) => l.event)).toEqual(["not_found", "not_found"]);
  });

  it("POST /api/analytics returns 204 for a not_found beacon", async () => {
    const resp = await POST(
      makeRequest({ event: "not_found", variant: "root", path: "/nope", pattern: "other" }),
    );
    expect(resp.status).toBe(204);
    expect(logs).toHaveLength(1);
  });
});
