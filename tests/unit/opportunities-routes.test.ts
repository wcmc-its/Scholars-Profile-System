/**
 * GrantRecs Phase 2, Task 8 — API route guards/validation for the matcher
 * routes. Mocks the lib matchers + the admin session so we test the route layer
 * only: param/allowlist validation, the superuser 403 gate, the public
 * cache-control header, and that the distinct `axes` payload is passed through.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const matchOpportunitiesForScholar = vi.fn();
const rankResearchersForOpportunity = vi.fn();
const getEffectiveEditSession = vi.fn();
const findUnique = vi.fn();
const opportunityFindMany = vi.fn();
const topicFindMany = vi.fn();

vi.mock("@/lib/api/match-opportunities", async (orig) => {
  const actual = await orig<typeof import("@/lib/api/match-opportunities")>();
  return { ...actual, matchOpportunitiesForScholar: (...a: unknown[]) => matchOpportunitiesForScholar(...a) };
});
// Keep the real (pure) opportunityTopTopics; only stub the I/O-bound matcher.
vi.mock("@/lib/api/match-researchers", async (orig) => {
  const actual = await orig<typeof import("@/lib/api/match-researchers")>();
  return { ...actual, rankResearchersForOpportunity: (...a: unknown[]) => rankResearchersForOpportunity(...a) };
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
      },
      topic: { findMany: (...a: unknown[]) => topicFindMany(...a) },
    },
  },
}));

import { GET as forwardGET } from "@/app/api/scholars/[cwid]/opportunities/route";
import { GET as reverseGET } from "@/app/api/opportunities/[opportunityId]/researchers/route";
import { GET as detailGET } from "@/app/api/opportunities/[opportunityId]/route";
import { GET as listGET } from "@/app/api/opportunities/route";

const req = (url: string) => new NextRequest(`http://localhost${url}`);
const p = <T,>(v: T) => Promise.resolve(v);

beforeEach(() => {
  vi.clearAllMocks();
  topicFindMany.mockResolvedValue([]); // default: no labels unless a test sets them
  opportunityFindMany.mockResolvedValue([]);
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

describe("GET /api/opportunities/[opportunityId]/researchers (reverse, admin-gated)", () => {
  it("403s when not a superuser", async () => {
    getEffectiveEditSession.mockResolvedValue(null);
    const resp = await reverseGET(req("/api/opportunities/g:1/researchers"), { params: p({ opportunityId: "g:1" }) });
    expect(resp.status).toBe(403);
    expect(rankResearchersForOpportunity).not.toHaveBeenCalled();
  });

  it("403s for an authenticated non-superuser who is not a developer", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "x", isSuperuser: false, isDeveloper: false });
    const resp = await reverseGET(req("/api/opportunities/g:1/researchers"), { params: p({ opportunityId: "g:1" }) });
    expect(resp.status).toBe(403);
    expect(rankResearchersForOpportunity).not.toHaveBeenCalled();
  });

  it("returns results for a development-role member who is not a superuser (Phase 4 gate)", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "dev", isSuperuser: false, isDeveloper: true });
    rankResearchersForOpportunity.mockResolvedValue([
      { cwid: "bbb", slug: "b", axes: { topicFit: 4.2, stageAppeal: 0.5 }, topicContributions: [], defaultScore: 4.2 },
    ]);
    const resp = await reverseGET(req("/api/opportunities/g:1/researchers"), { params: p({ opportunityId: "g:1" }) });
    expect(resp.status).toBe(200);
    expect(rankResearchersForOpportunity).toHaveBeenCalledTimes(1);
  });

  it("returns the view-model (card + matching-on chips + topic labels) and passes stageLens through", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "admin", isSuperuser: true });
    rankResearchersForOpportunity.mockResolvedValue([
      {
        cwid: "aaa",
        slug: "a",
        careerStage: "early",
        title: "Assistant Professor",
        department: "Medicine",
        axes: { topicFit: 9.7, stageAppeal: 0 },
        topicContributions: [{ topicId: "t1", contribution: 9.7, pubCount: 3, minYear: 2021 }],
        defaultScore: 9.7,
      },
    ]);
    findUnique.mockResolvedValue({
      title: "Opp T",
      mechanism: "R01",
      dueDate: null,
      sponsor: "NIH",
      source: "grants_gov",
      sourceUrl: "https://x",
      status: "open",
      topicVector: [{ topic_id: "t1", score: 0.8 }],
    });
    topicFindMany.mockResolvedValue([{ id: "t1", label: "Topic One" }]);
    const resp = await reverseGET(req("/api/opportunities/g:1/researchers?stageLens=1"), {
      params: p({ opportunityId: "g:1" }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.results[0]).toMatchObject({ title: "Assistant Professor", department: "Medicine" });
    expect(body.opportunity).toMatchObject({ title: "Opp T", mechanism: "R01", source: "grants_gov" });
    expect(body.matchingOn).toEqual([{ topicId: "t1", label: "Topic One", score: 0.8 }]);
    expect(body.topicLabels).toMatchObject({ t1: "Topic One" });
    expect(rankResearchersForOpportunity).toHaveBeenCalledWith("g:1", expect.objectContaining({ stageLens: true }));
  });
});

describe("GET /api/opportunities/[opportunityId] (detail)", () => {
  it("404s when the opportunity is absent", async () => {
    findUnique.mockResolvedValue(null);
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
});
