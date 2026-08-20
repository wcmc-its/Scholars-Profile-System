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
