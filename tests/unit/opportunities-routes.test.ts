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

vi.mock("@/lib/api/match-opportunities", async (orig) => {
  const actual = await orig<typeof import("@/lib/api/match-opportunities")>();
  return { ...actual, matchOpportunitiesForScholar: (...a: unknown[]) => matchOpportunitiesForScholar(...a) };
});
vi.mock("@/lib/api/match-researchers", () => ({
  rankResearchersForOpportunity: (...a: unknown[]) => rankResearchersForOpportunity(...a),
}));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: () => getEffectiveEditSession(),
}));
vi.mock("@/lib/db", () => ({ db: { read: { opportunity: { findUnique: (...a: unknown[]) => findUnique(...a) } } } }));

import { GET as forwardGET } from "@/app/api/scholars/[cwid]/opportunities/route";
import { GET as reverseGET } from "@/app/api/opportunities/[opportunityId]/researchers/route";
import { GET as detailGET } from "@/app/api/opportunities/[opportunityId]/route";

const req = (url: string) => new NextRequest(`http://localhost${url}`);
const p = <T,>(v: T) => Promise.resolve(v);

beforeEach(() => {
  vi.clearAllMocks();
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

  it("returns results for a superuser and passes stageLens through", async () => {
    getEffectiveEditSession.mockResolvedValue({ cwid: "admin", isSuperuser: true });
    rankResearchersForOpportunity.mockResolvedValue([
      { cwid: "aaa", slug: "a", axes: { topicFit: 9.7, stageAppeal: 0 }, topicContributions: [], defaultScore: 9.7 },
    ]);
    const resp = await reverseGET(req("/api/opportunities/g:1/researchers?stageLens=1"), {
      params: p({ opportunityId: "g:1" }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.results[0].axes).toMatchObject({ topicFit: 9.7, stageAppeal: 0 });
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
