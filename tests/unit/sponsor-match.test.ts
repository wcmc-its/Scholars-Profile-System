/**
 * CTL sponsor match (`docs/2026-07-09-ctl-technologies-handoff.md` §2):
 *  - the (cwid, pmid) dedupe — `publication_topic` keys on (pmid, cwid,
 *    parentTopicId), so one paper yields one row PER PARENT TOPIC and must be
 *    credited once (max-`score` row), never once per topic;
 *  - relevance actually WEIGHTS the ranking (not just gates the pool);
 *  - empty/whitespace/control-char input short-circuits with NO OpenSearch call;
 *  - route wiring: 404 while SPONSOR_MATCH is off, 403 + denial log for a
 *    non-developer, 400 on a missing description, 200 happy-path shape;
 *  - BOTH engines answer in the UI contract's `{ concepts, candidates }` shape (bespoke
 *    maps into it with no decomposition: empty concepts + empty contributions, but real
 *    measures/evidence);
 *  - there is NO `concepts` request field any more — #1673's server-side override is gone,
 *    because the console re-ranks client-side over the already-fetched candidates.
 * Mocks db + relevanceScoresForQuery — never live OpenSearch/MySQL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const {
  mockRelevanceScoresForQuery,
  mockPublicationTopicFindMany,
  mockScholarFindMany,
  mockTechnologyGroupBy,
  mockPublicationFindMany,
  mockTopicFindMany,
  mockReadEditRequest,
  mockLogEditDenial,
  mockRankForDescription,
  mockRankSpine,
} = vi.hoisted(() => ({
  mockRelevanceScoresForQuery: vi.fn(),
  mockPublicationTopicFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockTechnologyGroupBy: vi.fn(),
  mockPublicationFindMany: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockReadEditRequest: vi.fn(),
  mockLogEditDenial: vi.fn(),
  mockRankForDescription: vi.fn(),
  mockRankSpine: vi.fn(),
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
      publication: { findMany: mockPublicationFindMany },
      topic: { findMany: mockTopicFindMany },
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
// The spine engine is mocked whole for the route tests (engine SELECTION is what
// they cover); its composition is tested in `sponsor-match-spine-run.test.ts`.
vi.mock("@/lib/api/sponsor-match-spine-run", () => ({
  rankResearchersForDescriptionSpine: mockRankSpine,
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
  process.env.SPONSOR_MATCH_SPINE = "off";
  mockScholarFindMany.mockResolvedValue([]);
  mockTechnologyGroupBy.mockResolvedValue([]);
  mockPublicationFindMany.mockResolvedValue([]);
  mockTopicFindMany.mockResolvedValue([]);
  mockRankForDescription.mockResolvedValue([]);
  mockRankSpine.mockResolvedValue({ concepts: [], candidates: [] });
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

  it("attaches top-paper + matched-topic evidence post-ranking, ordered by contribution/coverage", async () => {
    mockRelevanceScoresForQuery.mockResolvedValue(
      new Map([
        ["p1", 1],
        ["p2", 0.2],
      ]),
    );
    // Scholar a: p1 carries topics t1+t2 (dedup credits it once, but the topic
    // EVIDENCE counts it under both); p2 carries t1 only.
    mockPublicationTopicFindMany.mockResolvedValue([
      row("a", "p1", "t1", 5),
      row("a", "p1", "t2", 3),
      row("a", "p2", "t1", 5),
    ]);
    mockPublicationFindMany.mockResolvedValue([
      { pmid: "p1", title: "Paper One", year: 2024, journal: "Blood" },
      { pmid: "p2", title: "Paper Two", year: 2023, journal: "Cell" },
    ]);
    mockTopicFindMany.mockResolvedValue([
      { id: "t1", label: "Topic One" },
      { id: "t2", label: "Topic Two" },
    ]);

    const [r] = await rankResearchersForDescription("car t exhaustion", { now: NOW });
    // p1 (rel 1) contributed more than p2 (rel 0.2) — evidence sorts by contribution.
    expect(r.topPapers.map((p) => p.pmid)).toEqual(["p1", "p2"]);
    expect(r.topPapers[0]).toMatchObject({
      title: "Paper One",
      journal: "Blood",
      year: 2024,
      relevance: 1,
    });
    // t1 covers 2 papers, t2 covers 1 — ordered by coverage, labeled from the topic table.
    expect(r.matchedTopics).toEqual([
      { topicId: "t1", label: "Topic One", pubCount: 2 },
      { topicId: "t2", label: "Topic Two", pubCount: 1 },
    ]);
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

  it("maps the bespoke engine into the contract shape (no decomposition ⇒ empty concepts)", async () => {
    // Both engines answer in ONE response shape, so the console has one type to consume.
    // Bespoke does no concept decomposition, so `concepts` and every `contributions` are
    // empty — the rail hides itself and the client re-rank is a no-op, which is the honest
    // rendering of an engine with no per-concept signal to edit. It DOES carry the
    // measures + evidence the spine's headless retrieval cannot produce.
    mockRankForDescription.mockResolvedValue([
      {
        cwid: "a",
        slug: "slug-a",
        preferredName: "Ada L",
        title: "Prof",
        department: "Medicine",
        careerStage: "senior",
        defaultScore: 4.2,
        technologyCount: 1,
        matchedTopics: [{ topicId: "t1", label: "Oncology", pubCount: 7 }],
        topPapers: [
          { pmid: "1", title: "P", year: 2020, journal: "J", relevance: 0.8 },
        ],
      },
    ]);
    const resp = await POST(postRequest(developerCtx, { description: "gene therapy" }));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      ok: true,
      concepts: [],
      candidates: [
        {
          cwid: "a",
          name: "Ada L",
          profileSlug: "slug-a",
          title: "Prof",
          department: "Medicine",
          fusedScore: 4.2,
          contributions: [],
          technologyCount: 1,
          measures: { careerStage: "senior" },
          evidence: {
            topics: [{ label: "Oncology", pubCount: 7 }],
            papers: [{ pmid: "1", title: "P", year: 2020, journal: "J", relevance: 0.8 }],
          },
        },
      ],
      // "gene therapy" is a purely topical paste — no non-topical ask to extract (#1654).
      preferences: [],
    });
    expect(mockRankForDescription).toHaveBeenCalledWith("gene therapy");
  });

  it("ships the non-topical asks it read out of the paste, on either engine (#1654)", async () => {
    // The extractor is engine-independent — it reads the paste, not the ranking — and the
    // ORDER is deliberately not pre-nudged here: the response carries the preferences and the
    // console applies the boost, so the officer can uncheck one the extractor got wrong.
    const resp = await POST(
      postRequest(developerCtx, {
        description: "We fund fibrosis work by early-career physician-scientists.",
      }),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.preferences.map((p: { label: string }) => p.label)).toEqual([
      "Early-career",
      "Physician-scientist",
    ]);
    expect(body.preferences[0]).toMatchObject({ measure: "careerStage", stages: ["early"] });
  });

  describe("engine selection (SPONSOR_MATCH_SPINE)", () => {
    it("spine flag OFF: always bespoke, and any `engine` field is ignored", async () => {
      process.env.SPONSOR_MATCH_SPINE = "off";
      const resp = await POST(postRequest(developerCtx, { description: "x", engine: "spine" }));
      expect(resp.status).toBe(200);
      expect(mockRankForDescription).toHaveBeenCalledWith("x");
      expect(mockRankSpine).not.toHaveBeenCalled();
    });

    it("spine flag ON: defaults to the spine engine (no engine field)", async () => {
      process.env.SPONSOR_MATCH_SPINE = "on";
      const resp = await POST(postRequest(developerCtx, { description: "x" }));
      expect(resp.status).toBe(200);
      expect(mockRankSpine).toHaveBeenCalledWith("x");
      expect(mockRankForDescription).not.toHaveBeenCalled();
    });

    it("spine flag ON: `engine: \"bespoke\"` forces the bespoke engine", async () => {
      process.env.SPONSOR_MATCH_SPINE = "on";
      const resp = await POST(postRequest(developerCtx, { description: "x", engine: "bespoke" }));
      expect(resp.status).toBe(200);
      expect(mockRankForDescription).toHaveBeenCalledWith("x");
      expect(mockRankSpine).not.toHaveBeenCalled();
    });

    it("spine flag ON: `engine: \"spine\"` forces the spine engine", async () => {
      process.env.SPONSOR_MATCH_SPINE = "on";
      const resp = await POST(postRequest(developerCtx, { description: "x", engine: "spine" }));
      expect(resp.status).toBe(200);
      expect(mockRankSpine).toHaveBeenCalledWith("x");
      expect(mockRankForDescription).not.toHaveBeenCalled();
    });

    it("spine flag ON: an unrecognized `engine` value → 400, neither engine called", async () => {
      process.env.SPONSOR_MATCH_SPINE = "on";
      const resp = await POST(postRequest(developerCtx, { description: "x", engine: "turbo" }));
      expect(resp.status).toBe(400);
      expect(await resp.json()).toMatchObject({ ok: false, error: "invalid_engine", field: "engine" });
      expect(mockRankForDescription).not.toHaveBeenCalled();
      expect(mockRankSpine).not.toHaveBeenCalled();
    });

    it("spine flag ON: ships the spine's decomposed concepts + candidates verbatim", async () => {
      process.env.SPONSOR_MATCH_SPINE = "on";
      const concepts = [
        {
          term: "cancer metabolism",
          kind: "concept",
          members: ["cancer metabolism"],
          centrality: 0.9,
          weightFactor: 3.2,
          corpusCoverage: 4.1e-4,
        },
      ];
      const candidates = [
        {
          cwid: "a",
          name: "Ada L",
          profileSlug: "slug-a",
          title: null,
          department: null,
          fusedScore: 1,
          contributions: [{ term: "cancer metabolism", rank: 1 }],
          technologyCount: 0,
        },
      ];
      mockRankSpine.mockResolvedValue({ concepts, candidates });
      const resp = await POST(postRequest(developerCtx, { description: "x" }));
      expect(resp.status).toBe(200);
      // The decomposed inputs must reach the client INTACT — both weight factors and
      // every per-concept rank. Anything the route drops here, the console cannot
      // re-rank over, and the sliders fall back to re-querying.
      // `preferences: []` — the paste stated no non-topical ask. Empty, not absent: the
      // route always answers the question, so a client can tell "no asks" from "this server
      // does not extract asks" (#1654).
      expect(await resp.json()).toEqual({ ok: true, concepts, candidates, preferences: [] });
    });
  });

  // #1673 accepted a client-supplied `concepts` override and re-retrieved + re-fused on
  // every slider drag. That is the "re-query on every drag" degradation the UI contract
  // rejects, and removing it also removed a client-controlled trust boundary. Re-ranking
  // is now client-side (`rerankCandidates`) over the already-fetched candidates.
  describe("no concept override (the contract's hinge)", () => {
    beforeEach(() => {
      process.env.SPONSOR_MATCH_SPINE = "on";
    });

    it("ignores a `concepts` body field entirely — it is not an input any more", async () => {
      const resp = await POST(
        postRequest(developerCtx, {
          description: "x",
          concepts: [{ term: "injected", centrality: 1 }],
        }),
      );
      expect(resp.status).toBe(200);
      // Not passed through, not validated, not 400 — simply not a parameter. The spine is
      // called with the description alone.
      expect(mockRankSpine).toHaveBeenCalledWith("x");
    });

    it("does not 400 on a garbage `concepts` field (there is no such trust boundary now)", async () => {
      const resp = await POST(postRequest(developerCtx, { description: "x", concepts: "nope" }));
      expect(resp.status).toBe(200);
      expect(mockRankSpine).toHaveBeenCalledWith("x");
    });
  });
});
