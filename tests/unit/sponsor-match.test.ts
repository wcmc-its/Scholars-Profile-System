/**
 * CTL sponsor match (`docs/2026-07-09-ctl-technologies-handoff.md` §2):
 *  - the (cwid, pmid) dedupe — `publication_topic` keys on (pmid, cwid,
 *    parentTopicId), so one paper yields one row PER PARENT TOPIC and must be
 *    credited once (max-`score` row), never once per topic;
 *  - relevance actually WEIGHTS the ranking (not just gates the pool);
 *  - empty/whitespace/control-char input short-circuits with NO OpenSearch call;
 *  - route wiring: 404 while SPONSOR_MATCH is off, 403 + denial log for a
 *    non-developer, 400 on a missing description, 200 happy-path shape.
 * Mocks db + relevanceScoresForQuery — never live OpenSearch/MySQL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const {
  mockRelevanceScoresForQuery,
  mockPublicationTopicFindMany,
  mockScholarFindMany,
  mockTechnologyGroupBy,
  mockReadEditRequest,
  mockLogEditDenial,
  mockRankForDescription,
} = vi.hoisted(() => ({
  mockRelevanceScoresForQuery: vi.fn(),
  mockPublicationTopicFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockTechnologyGroupBy: vi.fn(),
  mockReadEditRequest: vi.fn(),
  mockLogEditDenial: vi.fn(),
  mockRankForDescription: vi.fn(),
}));

vi.mock("@/lib/api/search", () => ({
  relevanceScoresForQuery: mockRelevanceScoresForQuery,
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      publicationTopic: { findMany: mockPublicationTopicFindMany },
      scholar: { findMany: mockScholarFindMany },
      scholarTechnology: { groupBy: mockTechnologyGroupBy },
    },
  },
}));
vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogEditDenial }));
// The route consumes the mocked engine; the engine tests reach the real one
// via `vi.importActual` below (its db/search imports stay mocked either way).
vi.mock("@/lib/api/sponsor-match", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/sponsor-match")>()),
  rankResearchersForDescription: mockRankForDescription,
}));

import { POST } from "@/app/api/edit/sponsor-match/route";

const { rankResearchersForDescription } =
  await vi.importActual<typeof import("@/lib/api/sponsor-match")>("@/lib/api/sponsor-match");

const NOW = new Date("2026-07-01T00:00:00Z");

/** One publication_topic row: same scholar+paper fields, varying (topic, score). */
function row(cwid: string, pmid: string, parentTopicId: string, score: number) {
  return {
    cwid,
    pmid,
    parentTopicId,
    score,
    year: 2024,
    authorPosition: "last",
    scholar: { cwid, slug: `slug-${cwid}`, preferredName: cwid.toUpperCase() },
    publication: {
      pmid,
      publicationType: "Academic Article",
      dateAddedToEntrez: new Date("2025-06-01T00:00:00Z"),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SPONSOR_MATCH = "on";
  mockScholarFindMany.mockResolvedValue([]);
  mockTechnologyGroupBy.mockResolvedValue([]);
});

describe("rankResearchersForDescription (engine)", () => {
  it("dedupes to one row per (cwid, pmid) — a multi-topic paper is credited once, at its max score", async () => {
    mockRelevanceScoresForQuery.mockResolvedValue(
      new Map([
        ["p1", 1],
        ["p2", 1],
      ]),
    );
    // Scholar a's ONE paper carries two parent-topic rows (scores 2 and 5);
    // scholar b's identical paper carries one row (score 5). Equal topicFit
    // proves the max-score row was kept: summing would put a ahead (7), and
    // keeping the min would put a behind (2).
    mockPublicationTopicFindMany.mockResolvedValue([
      row("a", "p1", "t1", 2),
      row("a", "p1", "t2", 5),
      row("b", "p2", "t1", 5),
    ]);

    const ranked = await rankResearchersForDescription("gene therapy vectors", { now: NOW });
    expect(ranked).toHaveLength(2);
    const a = ranked.find((r) => r.cwid === "a")!;
    const b = ranked.find((r) => r.cwid === "b")!;
    expect(a.axes.topicFit).toBeGreaterThan(0);
    expect(a.axes.topicFit).toBeCloseTo(b.axes.topicFit, 10);
    // The evidence counts the paper once too.
    expect(a.topicContributions).toHaveLength(1);
    expect(a.topicContributions[0]).toMatchObject({ topicId: "__sponsor_match__", pubCount: 1 });
  });

  it("weights by relevance — a more relevant paper outranks an otherwise identical one", async () => {
    mockRelevanceScoresForQuery.mockResolvedValue(
      new Map([
        ["p1", 0.2],
        ["p2", 1],
      ]),
    );
    mockPublicationTopicFindMany.mockResolvedValue([row("a", "p1", "t1", 5), row("b", "p2", "t1", 5)]);

    const ranked = await rankResearchersForDescription("oncolytic viruses", { now: NOW });
    expect(ranked.map((r) => r.cwid)).toEqual(["b", "a"]);
    expect(ranked[0].defaultScore).toBeCloseTo(ranked[1].defaultScore * 5, 10);
  });

  it("attaches title/department + technologyCount post-ranking", async () => {
    mockRelevanceScoresForQuery.mockResolvedValue(new Map([["p1", 1]]));
    mockPublicationTopicFindMany.mockResolvedValue([row("a", "p1", "t1", 5)]);
    mockScholarFindMany.mockResolvedValue([
      { cwid: "a", primaryTitle: "Professor", primaryDepartment: "Medicine" },
    ]);
    mockTechnologyGroupBy.mockResolvedValue([{ cwid: "a", _count: { _all: 3 } }]);

    const [r] = await rankResearchersForDescription("crispr", { now: NOW });
    expect(r).toMatchObject({ title: "Professor", department: "Medicine", technologyCount: 3 });
  });

  it("returns [] for empty/whitespace/control-char input WITHOUT an OpenSearch call", async () => {
    expect(await rankResearchersForDescription("")).toEqual([]);
    expect(await rankResearchersForDescription("   \n\t  ")).toEqual([]);
    // Control chars strip to whitespace (built at runtime; no literal control
    // bytes in source -- the #1602 binary-diff trap).
    expect(await rankResearchersForDescription(String.fromCharCode(0, 7, 27, 127))).toEqual([]);
    expect(mockRelevanceScoresForQuery).not.toHaveBeenCalled();
    expect(mockPublicationTopicFindMany).not.toHaveBeenCalled();
  });

  it("returns [] when the relevance set is empty, without querying the pool", async () => {
    mockRelevanceScoresForQuery.mockResolvedValue(new Map());
    expect(await rankResearchersForDescription("no corpus overlap")).toEqual([]);
    expect(mockPublicationTopicFindMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit/sponsor-match (route)", () => {
  const developerCtx = {
    session: { cwid: "dev1", isSuperuser: false, isDeveloper: true },
    effective: { cwid: "dev1", isSuperuser: false, isDeveloper: true },
    realCwid: "dev1",
    impersonatedCwid: null,
    requestId: "req-1",
    body: {} as Record<string, unknown>,
  };

  function postRequest(ctx: typeof developerCtx, body: Record<string, unknown>) {
    mockReadEditRequest.mockResolvedValue({ ok: true, ctx: { ...ctx, body } });
    return {} as NextRequest;
  }

  it("404s while the flag is off", async () => {
    process.env.SPONSOR_MATCH = "off";
    const resp = await POST(postRequest(developerCtx, { description: "x" }));
    expect(resp.status).toBe(404);
    expect(mockReadEditRequest).not.toHaveBeenCalled();
  });

  it("403s + logs a denial for a non-developer", async () => {
    const nonDev = {
      ...developerCtx,
      session: { cwid: "x1", isSuperuser: false, isDeveloper: false },
      effective: { cwid: "x1", isSuperuser: false, isDeveloper: false },
      realCwid: "x1",
    };
    const resp = await POST(postRequest(nonDev, { description: "x" }));
    expect(resp.status).toBe(403);
    expect(mockLogEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/edit/sponsor-match", reason: "not_developer_post" }),
    );
    expect(mockRankForDescription).not.toHaveBeenCalled();
  });

  it("400s on a missing/blank description", async () => {
    expect((await POST(postRequest(developerCtx, {}))).status).toBe(400);
    expect((await POST(postRequest(developerCtx, { description: "  " }))).status).toBe(400);
    expect(mockRankForDescription).not.toHaveBeenCalled();
  });

  it("200s with the ranked researchers from the engine", async () => {
    mockRankForDescription.mockResolvedValue([
      { cwid: "a", slug: "slug-a", defaultScore: 4.2, technologyCount: 1 },
    ]);
    const resp = await POST(postRequest(developerCtx, { description: "gene therapy" }));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      ok: true,
      researchers: [{ cwid: "a", slug: "slug-a", defaultScore: 4.2, technologyCount: 1 }],
    });
    expect(mockRankForDescription).toHaveBeenCalledWith("gene therapy");
  });
});
