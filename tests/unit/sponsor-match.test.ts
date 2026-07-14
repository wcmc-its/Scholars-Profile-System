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
  mockSubmissionCreate,
  mockSubmissionDeleteMany,
  mockSubmissionFindMany,
  mockSubmissionFindUnique,
  mockGetEffectiveEditSession,
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
  mockSubmissionCreate: vi.fn(),
  mockSubmissionDeleteMany: vi.fn(),
  mockSubmissionFindMany: vi.fn(),
  mockSubmissionFindUnique: vi.fn(),
  mockGetEffectiveEditSession: vi.fn(),
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
      sponsorMatchSubmission: {
        findMany: mockSubmissionFindMany,
        findUnique: mockSubmissionFindUnique,
      },
    },
    write: {
      sponsorMatchSubmission: {
        create: mockSubmissionCreate,
        deleteMany: mockSubmissionDeleteMany,
      },
    },
  },
}));
vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogEditDenial }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEffectiveEditSession,
}));
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

import { DELETE, GET, POST } from "@/app/api/edit/sponsor-match/route";

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
          // Producer #2 of the headshot (the spine is producer #1, asserted in
          // `sponsor-match-spine-run.test.ts`). Derived SERVER-SIDE from the cwid: the field is
          // OPTIONAL on the contract, so only a test stops a producer quietly dropping it — and
          // a card that silently falls back to initials is indistinguishable from a scholar who
          // has no photo. It cannot be derived in the panel: `identityImageEndpoint` reads
          // `process.env.SCHOLARS_HEADSHOT_BASE`, which does not exist in a client component.
          identityImageEndpoint:
            "https://directory.weill.cornell.edu/api/v1/person/profile/a.png?returnGenericOn404=false",
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
      // `ask` is DERIVED from those concepts, not generated by a second LLM call — see
      // `sponsorAskFrom`. It names the search after its top concepts so the officer (and, later,
      // a submissions list) has a handle that costs no Bedrock tokens and cannot fail.
      expect(await resp.json()).toEqual({
        ok: true,
        concepts,
        candidates,
        preferences: [],
        ask: { title: "cancer metabolism" },
      });
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

  // ── Retention (#6d) ───────────────────────────────────────────────────────
  describe("retained searches", () => {
    it("retains the search — the paste IN FULL, its handle, engine, count and actor", async () => {
      process.env.SPONSOR_MATCH_SPINE = "on";
      mockRankSpine.mockResolvedValue({
        concepts: [
          { term: "cancer metabolism", kind: "concept", members: [], centrality: 0.9, weightFactor: 1 },
        ],
        candidates: [
          {
            cwid: "a",
            name: "A",
            profileSlug: "a",
            title: null,
            department: null,
            fusedScore: 0.1,
            contributions: [],
            technologyCount: 0,
          },
        ],
      });

      const resp = await POST(postRequest(developerCtx, { description: "  Cancer metabolism.  " }));
      expect(resp.status).toBe(200);

      expect(mockSubmissionCreate).toHaveBeenCalledTimes(1);
      const { data } = mockSubmissionCreate.mock.calls[0][0];
      // THE PASTE, VERBATIM — not the engine's normalised/truncated view of it. Keeping the
      // real text is the entire reason this row exists (the λ gold set needs REAL sponsor
      // prose, not our reconstruction of it).
      expect(data.description).toBe("  Cancer metabolism.  ");
      expect(data.title).toBe("cancer metabolism");
      expect(data.engine).toBe("spine");
      expect(data.candidateCount).toBe(1);
      expect(data.submittedBy).toBe("dev1");
      // A 64-char hex digest — the same key the result cache uses, so a row and its cached
      // result identify the same search.
      expect(data.descriptionHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("STILL SERVES THE RANKING when the retention write fails — the archive is a by-product", async () => {
      // A retention failure must never cost the officer their answer. If this ever regresses,
      // a DB blip takes down the matcher itself.
      process.env.SPONSOR_MATCH_SPINE = "on";
      mockRankSpine.mockResolvedValue({ concepts: [], candidates: [] });
      mockSubmissionCreate.mockRejectedValue(new Error("db down"));

      const resp = await POST(postRequest(developerCtx, { description: "x" }));
      expect(resp.status).toBe(200);
      expect(await resp.json()).toMatchObject({ ok: true });
    });

    it("DELETE erases EVERY RUN of that paste — the console's promise, made true", async () => {
      // THE BUG THIS REPLACES, and the test that used to enshrine it:
      //   expect(mockSubmissionDeleteMany).toHaveBeenCalledWith({ where: { id: "s1" } })
      //
      // The console says, verbatim: "Delete any search to remove its text for good." It was not
      // true. `descriptionHash` is deliberately NON-UNIQUE — every re-run of a paste is its own
      // row, because the record of WHEN a result changed is the reason the table exists. So a
      // paste run three times had THREE rows carrying the sponsor's prose in full, and deleting
      // by `id` erased one and left the text sitting in the other two.
      //
      // Staging had exactly this: one paste, four rows. A retention promise that holds only for
      // pastes run exactly once is not a retention promise. The unit of erasure is the PASTE.
      mockSubmissionFindUnique.mockResolvedValue({ descriptionHash: "h-abc" });
      mockSubmissionDeleteMany.mockResolvedValue({ count: 3 }); // three runs of the same paste

      const resp = await DELETE(postRequest(developerCtx, { submissionId: "s1" }));

      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true, deleted: "s1", count: 3 });
      // BY HASH, NOT BY ID. Revert this to `{ where: { id: "s1" } }` and the sponsor's words
      // survive their own deletion.
      expect(mockSubmissionDeleteMany).toHaveBeenCalledWith({
        where: { descriptionHash: "h-abc" },
      });
    });

    it("DELETE 404s when the row is already gone", async () => {
      // Unchanged behaviour: two officers clicking the same button, or a retry. The lookup finds
      // nothing, so there is no hash to erase by — 404, not a 500.
      mockSubmissionFindUnique.mockResolvedValue(null);
      const resp = await DELETE(postRequest(developerCtx, { submissionId: "nope" }));
      expect(resp.status).toBe(404);
      expect(mockSubmissionDeleteMany).not.toHaveBeenCalled();
    });

    it("DELETE 403s for a non-developer, with a denial log", async () => {
      const ctx = {
        ...developerCtx,
        session: { cwid: "usr1", isSuperuser: false, isDeveloper: false },
      };
      const resp = await DELETE(postRequest(ctx, { submissionId: "s1" }));
      expect(resp.status).toBe(403);
      expect(mockLogEditDenial).toHaveBeenCalled();
      expect(mockSubmissionDeleteMany).not.toHaveBeenCalled();
      // Authorisation precedes the lookup — a denied caller learns nothing, not even whether
      // the row exists.
      expect(mockSubmissionFindUnique).not.toHaveBeenCalled();
    });

    it("DELETE 400s on a missing submissionId", async () => {
      const resp = await DELETE(postRequest(developerCtx, {}));
      expect(resp.status).toBe(400);
      expect(mockSubmissionDeleteMany).not.toHaveBeenCalled();
    });

    it("GET lists ONE ROW PER PASTE — four runs of the same paste are not four searches", async () => {
      // Reported from staging as "the search history is a duplicate": one paste, run four times,
      // rendered as four identical rows. They are not a bug in the TABLE — `descriptionHash` is
      // deliberately non-unique so a re-run after a nightly reindex stays its own record (the
      // real rows read 438 candidates on 7/13 and 430 on 7/14; that delta is why runs are kept).
      //
      // But the LIST answers three per-PASTE questions — has a colleague run this sponsor, can I
      // re-run it, can I erase it — and answering them four times reads as breakage. The rows
      // stay in the DB for measurement; the console shows the newest run of each paste.
      mockGetEffectiveEditSession.mockResolvedValue({
        cwid: "dev1",
        isSuperuser: false,
        isDeveloper: true,
      });
      mockSubmissionFindMany.mockResolvedValue([
        { id: "r4", descriptionHash: "h-adc", candidateCount: 430, description: "ADC" },
        { id: "r3", descriptionHash: "h-adc", candidateCount: 430, description: "ADC" },
        { id: "r2", descriptionHash: "h-adc", candidateCount: 438, description: "ADC" },
        { id: "r1", descriptionHash: "h-other", candidateCount: 12, description: "other" },
      ]);

      const body = await (await GET()).json();

      // Two PASTES, not four runs — and the ADC row is the NEWEST run (r4/430), because that is
      // the one whose id the Delete button carries and whose count is current.
      expect(body.submissions.map((x: { id: string }) => x.id)).toEqual(["r4", "r1"]);
      expect(body.submissions[0].candidateCount).toBe(430);
      // The join key is internal — it must not reach the client, or something will depend on it.
      expect(body.submissions[0]).not.toHaveProperty("descriptionHash");
      // The scan window must exceed the page size, or a heavily re-run paste starves the list.
      expect(mockSubmissionFindMany.mock.calls[0][0].take).toBe(500);
    });
  });
});
