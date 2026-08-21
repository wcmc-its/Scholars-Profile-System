/**
 * GrantRecs Phase 2, Task 8 — API route guards/validation for the matcher
 * routes. Mocks the lib matchers + the admin session so we test the route layer
 * only: param/allowlist validation, the superuser 403 gate, the public
 * cache-control header, and that the distinct `axes` payload is passed through.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const matchOpportunitiesForScholar = vi.fn();
const getEffectiveEditSession = vi.fn();
const findUnique = vi.fn();
const opportunityFindMany = vi.fn();
const opportunityGroupBy = vi.fn();
const topicFindMany = vi.fn();

vi.mock("@/lib/api/match-opportunities", async (orig) => {
  const actual = await orig<typeof import("@/lib/api/match-opportunities")>();
  return { ...actual, matchOpportunitiesForScholar: (...a: unknown[]) => matchOpportunitiesForScholar(...a) };
});
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: () => getEffectiveEditSession(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      opportunity: {
        findUnique: (...a: unknown[]) => findUnique(...a),
        findMany: (...a: unknown[]) => opportunityFindMany(...a),
        groupBy: (...a: unknown[]) => opportunityGroupBy(...a),
      },
      topic: { findMany: (...a: unknown[]) => topicFindMany(...a) },
    },
  },
}));

import { GET as forwardGET } from "@/app/api/scholars/[cwid]/opportunities/route";
import { GET as detailGET } from "@/app/api/opportunities/[opportunityId]/route";
import { GET as listGET } from "@/app/api/opportunities/route";

const req = (url: string) => new NextRequest(`http://localhost${url}`);
const p = <T,>(v: T) => Promise.resolve(v);

beforeEach(() => {
  vi.clearAllMocks();
  topicFindMany.mockResolvedValue([]); // default: no labels unless a test sets them
  opportunityFindMany.mockResolvedValue([]);
  opportunityGroupBy.mockResolvedValue([]); // per-source freshness aggregate
});

describe("GET /api/scholars/[cwid]/opportunities (forward, public)", () => {
  it("returns results with a public cache-control header and the axes payload", async () => {
    matchOpportunitiesForScholar.mockResolvedValue([
      { opportunityId: "g:1", axes: { topicAffinity: 0.9, stageAppeal: 0.8, meshOverlap: 0, deadlineProximity: 1 }, defaultScore: 1.6 },
    ]);
    const resp = await forwardGET(req("/api/scholars/abc1234/opportunities?sort=deadline"), {
      params: p({ cwid: "abc1234" }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Cache-Control")).toContain("public");
    const body = await resp.json();
    expect(body.results[0].axes).toMatchObject({ topicAffinity: 0.9, stageAppeal: 0.8 });
    expect(matchOpportunitiesForScholar).toHaveBeenCalledWith("abc1234", expect.objectContaining({ sort: "deadline" }));
  });

  it("resolves matchedTopics chip labels — ids+labels+pubCounts only, never scores (#1610)", async () => {
    matchOpportunitiesForScholar.mockResolvedValue([
      {
        opportunityId: "g:1",
        axes: { topicAffinity: 0.9, stageAppeal: 0.8, meshOverlap: 0, deadlineProximity: 1 },
        defaultScore: 1.6,
        matchedTopics: [
          { topicId: "t1", pubCount: 4 },
          { topicId: "t2", pubCount: 2 },
        ],
      },
    ]);
    topicFindMany.mockResolvedValue([{ id: "t1", label: "Topic One" }]);
    const resp = await forwardGET(req("/api/scholars/abc1234/opportunities"), {
      params: p({ cwid: "abc1234" }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.results[0].matchedTopics).toEqual([
      { topicId: "t1", pubCount: 4, label: "Topic One" },
      { topicId: "t2", pubCount: 2, label: "t2" }, // unknown id → label falls back to the id
    ]);
    // Contract: the chips never carry per-topic ranking math.
    for (const t of body.results[0].matchedTopics) {
      expect(Object.keys(t).sort()).toEqual(["label", "pubCount", "topicId"]);
    }
  });

  it("400s on an invalid sort", async () => {
    const resp = await forwardGET(req("/api/scholars/abc1234/opportunities?sort=bogus"), { params: p({ cwid: "abc1234" }) });
    expect(resp.status).toBe(400);
    expect(matchOpportunitiesForScholar).not.toHaveBeenCalled();
  });

  it("400s on a malformed cwid", async () => {
    const resp = await forwardGET(req("/api/scholars/bad%20id/opportunities"), { params: p({ cwid: "bad id" }) });
    expect(resp.status).toBe(400);
  });

  it("400s on malformed weights", async () => {
    const resp = await forwardGET(req("/api/scholars/abc1234/opportunities?weights=topic:nope"), {
      params: p({ cwid: "abc1234" }),
    });
    expect(resp.status).toBe(400);
  });
});

describe("GET /api/opportunities/[opportunityId] (detail)", () => {
  it("404s when the opportunity is absent", async () => {
    findUnique.mockResolvedValue(null);
    const resp = await detailGET(req("/api/opportunities/g:1"), { params: p({ opportunityId: "g:1" }) });
    expect(resp.status).toBe(404);
  });

  it("404s a manually-suppressed row (matcha-admin Phase 1b)", async () => {
    findUnique.mockResolvedValue({
      opportunityId: "g:1",
      title: "T",
      suppressedAt: new Date("2026-08-01T00:00:00Z"),
      awardCeiling: null,
      awardFloor: null,
      estimatedFunding: null,
    });
    const resp = await detailGET(req("/api/opportunities/g:1"), { params: p({ opportunityId: "g:1" }) });
    expect(resp.status).toBe(404);
  });

  it("coerces BigInt award fields and returns the row", async () => {
    findUnique.mockResolvedValue({ opportunityId: "g:1", title: "T", awardCeiling: 500000n, awardFloor: null, estimatedFunding: 3000000n });
    const resp = await detailGET(req("/api/opportunities/g:1"), { params: p({ opportunityId: "g:1" }) });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.awardCeiling).toBe(500000);
    expect(body.estimatedFunding).toBe(3000000);
  });

  it("never serializes the suppression trio on the public wire (matcha-admin Phase 1b)", async () => {
    findUnique.mockResolvedValue({
      opportunityId: "g:1", title: "T", awardCeiling: null, awardFloor: null, estimatedFunding: null,
      suppressedAt: null, suppressedBy: null, suppressReason: null,
    });
    const resp = await detailGET(req("/api/opportunities/g:1"), { params: p({ opportunityId: "g:1" }) });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).not.toHaveProperty("suppressedAt");
    expect(body).not.toHaveProperty("suppressedBy");
    expect(body).not.toHaveProperty("suppressReason");
  });
});

describe("GET /api/opportunities (browse list, admin-gated, curated-first)", () => {
  it("403s when not a superuser or developer", async () => {
    getEffectiveEditSession.mockResolvedValue(null);
    const resp = await listGET(req("/api/opportunities"));
    expect(resp.status).toBe(403);
    expect(opportunityFindMany).not.toHaveBeenCalled();
  });

  it("excludes grants.gov by default and orders curated first", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "dev", isSuperuser: false, isDeveloper: true });
    opportunityFindMany.mockResolvedValue([
      { opportunityId: "wcm_curated:z", title: "Zeta Prize", source: "wcm_curated" },
      { opportunityId: "wcm_curated:a", title: "Alpha Prize", source: "wcm_curated" },
    ]);
    const resp = await listGET(req("/api/opportunities"));
    expect(resp.status).toBe(200);
    // default query excludes grants.gov
    expect(opportunityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ source: { not: "grants_gov" } }) }),
    );
    const body = await resp.json();
    // curated tier, then alphabetical by title
    expect(body.opportunities.map((o: { opportunityId: string }) => o.opportunityId)).toEqual([
      "wcm_curated:a",
      "wcm_curated:z",
    ]);
  });

  it("folds in grants.gov when includeGrantsGov=1, with curated still first", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "admin", isSuperuser: true });
    opportunityFindMany.mockResolvedValue([
      { opportunityId: "grants_gov:1", title: "AAA NOFO", source: "grants_gov" },
      { opportunityId: "wcm_curated:x", title: "ZZZ Award", source: "wcm_curated" },
    ]);
    const resp = await listGET(req("/api/opportunities?includeGrantsGov=1"));
    expect(resp.status).toBe(200);
    // no source filter when including grants.gov
    const callArg = opportunityFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(callArg.where.source).toBeUndefined();
    const body = await resp.json();
    // curated leads despite a later title, then grants.gov
    expect(body.opportunities.map((o: { opportunityId: string }) => o.opportunityId)).toEqual([
      "wcm_curated:x",
      "grants_gov:1",
    ]);
  });

  it("400s on an invalid limit", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "admin", isSuperuser: true });
    const resp = await listGET(req("/api/opportunities?limit=0"));
    expect(resp.status).toBe(400);
  });

  it("excludes suppressed rows by default; includeSuppressed=1 folds them in with the admin fields", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "admin", isSuperuser: true });

    await listGET(req("/api/opportunities"));
    expect(opportunityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ suppressedAt: null }) }),
    );

    opportunityFindMany.mockResolvedValue([
      {
        opportunityId: "manual_url:x-abc123",
        title: "Suppressed Award",
        source: "manual_url",
        suppressedAt: new Date("2026-08-01T00:00:00.000Z"),
        suppressedBy: "flm4001",
        suppressReason: "dup",
      },
    ]);
    const resp = await listGET(req("/api/opportunities?includeSuppressed=1"));
    expect(resp.status).toBe(200);
    const callArg = opportunityFindMany.mock.calls[1][0] as { where: Record<string, unknown> };
    expect(callArg.where.suppressedAt).toBeUndefined();
    const body = await resp.json();
    // the admin view renders muted rows + Restore off these three fields
    expect(body.opportunities[0]).toMatchObject({
      suppressedAt: "2026-08-01T00:00:00.000Z",
      suppressedBy: "flm4001",
      suppressReason: "dup",
    });
  });

  /**
   * Browse data-wiring 2026-08 — the card rows + Research-area facet ship as derived fields
   * (`concepts`, `eligibilityLabels`, `researchArea`); the raw JSON columns they come from
   * must never reach the wire.
   */
  it("derives concepts from topicVector — label-resolved, score-sorted, floor-dropped, top-3", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "admin", isSuperuser: true });
    topicFindMany.mockResolvedValue([{ id: "cancer_genomics", label: "Cancer Genomics" }]);
    opportunityFindMany.mockResolvedValue([
      {
        opportunityId: "wcm_curated:a",
        title: "Alpha",
        source: "wcm_curated",
        topicVector: [
          // Stored unsorted; the route sorts by score desc.
          { topic_id: "implementation_science", score: 0.4, rationale: "r" },
          { topic_id: "cancer_genomics", score: 0.9, rationale: "r" },
          { topic_id: "neuroscience_neurology", score: 0.2 },
          { topic_id: "oral_craniofacial_health", score: 0.1 }, // 4th — capped off
          { topic_id: "noise", score: 0.04 }, // under the 0.05 floor
        ],
        primaryTopicId: "cancer_genomics",
      },
    ]);
    const resp = await listGET(req("/api/opportunities"));
    expect(resp.status).toBe(200);
    expect(opportunityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ topicVector: true, primaryTopicId: true }),
      }),
    );
    const body = await resp.json();
    expect(body.opportunities[0].concepts).toEqual([
      { label: "Cancer Genomics", score: 0.9 }, // resolved via the topic table
      { label: "Implementation science", score: 0.4 }, // no topic row → humanized slug
      { label: "Neuroscience neurology", score: 0.2 },
    ]);
    expect(body.opportunities[0].researchArea).toEqual({
      id: "cancer_genomics",
      label: "Cancer Genomics",
    });
    // The raw columns exist only to derive the fields above.
    expect(body.opportunities[0]).not.toHaveProperty("topicVector");
    expect(body.opportunities[0]).not.toHaveProperty("primaryTopicId");
    expect(body.opportunities[0]).not.toHaveProperty("eligibility");
    expect(body.opportunities[0]).not.toHaveProperty("eligibilityFlags");
  });

  it("dedupes concepts on the resolved label (the chip's React key), keeping the higher score", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "admin", isSuperuser: true });
    topicFindMany.mockResolvedValue([{ id: "cancer_genomics", label: "Cancer Genomics" }]);
    opportunityFindMany.mockResolvedValue([
      {
        opportunityId: "wcm_curated:a",
        title: "Alpha",
        source: "wcm_curated",
        topicVector: [
          { topic_id: "cancer_genomics", score: 0.9, rationale: "r" },
          { topic_id: "cancer_genomics", score: 0.7, rationale: "r" }, // duplicated id — one chip
          { topic_id: "implementation_science", score: 0.6 },
          { topic_id: "immunology", score: 0.5 }, // still fills the third slot past the dupe
        ],
        primaryTopicId: null,
      },
    ]);
    const resp = await listGET(req("/api/opportunities"));
    const body = await resp.json();
    expect(body.opportunities[0].concepts).toEqual([
      { label: "Cancer Genomics", score: 0.9 },
      { label: "Implementation science", score: 0.6 },
      { label: "Immunology", score: 0.5 },
    ]);
  });

  it("humanizes an unresolved primaryTopicId slug; a row without one gets null", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "admin", isSuperuser: true });
    opportunityFindMany.mockResolvedValue([
      {
        opportunityId: "wcm_curated:a",
        title: "Alpha",
        source: "wcm_curated",
        primaryTopicId: "implementation_science", // 353 staging opps carry a slug with no topic row
      },
      { opportunityId: "wcm_curated:b", title: "Beta", source: "wcm_curated", primaryTopicId: null },
    ]);
    const resp = await listGET(req("/api/opportunities"));
    const body = await resp.json();
    expect(body.opportunities[0].researchArea).toEqual({
      id: "implementation_science",
      label: "Implementation science",
    });
    expect(body.opportunities[1].researchArea).toBeNull();
  });

  it("survives an absent, empty or malformed topicVector — concepts is just empty", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "admin", isSuperuser: true });
    opportunityFindMany.mockResolvedValue([
      { opportunityId: "wcm_curated:a", title: "A", source: "wcm_curated" }, // column absent
      { opportunityId: "wcm_curated:b", title: "B", source: "wcm_curated", topicVector: [] },
      { opportunityId: "wcm_curated:c", title: "C", source: "wcm_curated", topicVector: "junk" },
      {
        opportunityId: "wcm_curated:d",
        title: "D",
        source: "wcm_curated",
        // Entry-level junk: wrong types, missing halves, nulls, nested arrays.
        topicVector: [null, {}, { topic_id: 42, score: 0.9 }, { topic_id: "x", score: "high" }, []],
      },
    ]);
    const resp = await listGET(req("/api/opportunities"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    for (const o of body.opportunities) expect(o.concepts).toEqual([]);
  });

  it("derives eligibilityLabels from real data only; an unrestricted row gets none", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "admin", isSuperuser: true });
    opportunityFindMany.mockResolvedValue([
      {
        opportunityId: "wcm_curated:a",
        title: "Alpha",
        source: "wcm_curated",
        eligibilityFlags: ["faculty_eligible", "postdoc_eligible", "student_only"],
        eligibility: {
          career_stages: ["early_career_faculty", "postdoc", "graduate_student"],
          esi_targeted: true,
          us_citizen_or_permanent_resident_required: true,
        },
      },
      {
        // `career_stages: []` explicitly means "no person-level restriction" — no labels,
        // even though the derived flags carry a faculty signal.
        opportunityId: "wcm_curated:b",
        title: "Beta",
        source: "wcm_curated",
        eligibilityFlags: ["faculty_eligible"],
        eligibility: { career_stages: [] },
      },
    ]);
    const resp = await listGET(req("/api/opportunities"));
    const body = await resp.json();
    expect(body.opportunities[0].eligibilityLabels).toEqual([
      "Faculty",
      "Postdocs",
      "Students",
      "Early Stage Investigators",
      "US required",
    ]);
    expect(body.opportunities[1].eligibilityLabels).toEqual([]);
  });

  it("returns the per-source freshness aggregate (count + newest ingestedAt, source-sorted)", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "admin", isSuperuser: true });
    opportunityGroupBy.mockResolvedValue([
      {
        source: "wcm_curated",
        _count: { _all: 320 },
        _max: { ingestedAt: new Date("2026-07-06T00:00:00.000Z") },
      },
      {
        source: "grants_gov",
        _count: { _all: 800 },
        _max: { ingestedAt: new Date("2026-07-01T00:00:00.000Z") },
      },
    ]);
    const resp = await listGET(req("/api/opportunities"));
    expect(resp.status).toBe(200);
    expect(opportunityGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ["source"], _max: { ingestedAt: true } }),
    );
    const body = await resp.json();
    expect(body.sources).toEqual([
      { source: "grants_gov", count: 800, newestIngestedAt: "2026-07-01T00:00:00.000Z" },
      { source: "wcm_curated", count: 320, newestIngestedAt: "2026-07-06T00:00:00.000Z" },
    ]);
  });
});
