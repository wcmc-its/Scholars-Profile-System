/**
 * Search reason-from-doc (lazy key papers, §5, commit 5) — `fetchKeyPaper`.
 * Returns the same `RepresentativePub` shape the inline rep-pub did
 * (pmid/title/titleHtml/year), scoped to ONE scholar + the resolved concept
 * subtree, highlighting the literal query.
 */
import { describe, expect, it, vi } from "vitest";

// Capture the body `fetchKeyPaper` sends so we can assert the scholar + concept
// scoping and the size-3 top-papers fetch.
const captured: Array<Record<string, unknown>> = [];
const keyPaperHit = {
  _source: { pmid: 42424242, title: "Glandular adenocarcinoma sequencing", year: 2023 },
  highlight: { title: ["Glandular <mark>adenocarcinoma</mark> sequencing"] },
};

vi.mock("@/lib/db", () => ({
  prisma: { publicationTopic: { groupBy: vi.fn().mockResolvedValue([]) } },
}));

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_METHOD_CONTEXT_BOOST: 0.5,
  PEOPLE_TOPIC_METHOD_CONTEXT_BOOST: 0.8,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      captured.push(JSON.parse(JSON.stringify(req.body)));
      return { body: { hits: { hits: [keyPaperHit] } } };
    },
  }),
}));

// MATCHA_GLOSS_INWORDS — the gloss has to BUCKET the key-paper cache key (`titleHtml` is part of the
// cached VALUE), but the real cache bypasses under VITEST, so a hit/miss harness would observe
// nothing. Capture the key instead, through the same pass-through stub `matcha-extract.test.ts`
// uses — every other test here still runs the loader untouched.
const capturedCacheKeys: string[] = [];
vi.mock("@/lib/api/reason-agg-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/reason-agg-cache")>()),
  cachedReasonAgg: async (key: string, load: () => Promise<unknown>) => {
    capturedCacheKeys.push(key);
    return load();
  },
}));

import { fetchKeyPaper, parseReasonTopHits, rankKeyPaperHitsByBlend } from "@/lib/api/search";

// `body.query` is a bare bool now (the recency `function_score` wrapper was
// dropped — recency lives in the app-side blend re-rank). `boolOf` still tolerates
// a wrapper so the admission assertions stay shape-agnostic.
type BoolQuery = { bool: { filter: unknown[]; should?: unknown[] } };
const boolOf = (q: unknown): BoolQuery["bool"] => {
  const wrapped = q as { function_score?: { query: BoolQuery } } & Partial<BoolQuery>;
  return wrapped.function_score ? wrapped.function_score.query.bool : (q as BoolQuery).bool;
};

describe("parseReasonTopHits — per-person authorship role", () => {
  /** One paper, TWO WCM authors with different roles. This is the case the paper-level
   *  `wcmAuthorPositions` union cannot represent: it holds ["first","middle"] and cannot say which
   *  author is which. Attribute by cwid or do not attribute at all. */
  const collaboration = {
    top: {
      hits: {
        hits: [
          {
            _source: {
              pmid: "1",
              title: "A collaboration",
              year: 2024,
              journal: "Nature",
              wcmAuthors: [
                { cwid: "sen0001", role: "last" },
                { cwid: "mid0001", role: "middle" },
              ],
            },
          },
        ],
      },
    },
  };

  it("gives each scholar THEIR role on the same paper — not the paper's", () => {
    expect(parseReasonTopHits(collaboration, 3, "sen0001")[0].role).toBe("last");
    expect(parseReasonTopHits(collaboration, 3, "mid0001")[0].role).toBe("middle");
  });

  it("omits the role entirely when the scholar is not on the paper's WCM author list", () => {
    // Under-claim rather than mislabel. Returning "middle" here would be inventing an authorship.
    expect(parseReasonTopHits(collaboration, 3, "nobody")[0]).not.toHaveProperty("role");
  });

  it("omits the role with no `forCwid` — the inline reason-agg path, which selects no wcmAuthors", () => {
    expect(parseReasonTopHits(collaboration, 3)[0]).not.toHaveProperty("role");
  });

  it("omits the role on a PRE-REINDEX document — absent is unknown, not 'middle'", () => {
    // Every document indexed before `wcmAuthors.role` exists carries a wcmAuthors entry with no
    // role. Rendering the weakest role on a missing field would silently demote every senior author
    // on every stale document in the index — a wrong answer that looks exactly like a right one.
    const stale = {
      top: {
        hits: {
          hits: [
            {
              _source: {
                pmid: "2",
                title: "Indexed last year",
                wcmAuthors: [{ cwid: "sen0001" }],
              },
            },
          ],
        },
      },
    };
    expect(parseReasonTopHits(stale, 3, "sen0001")[0]).not.toHaveProperty("role");
  });

  it("rejects a role the index should never have held", () => {
    // `_source` is a trust boundary: a half-run reindex or a hand-patched doc can hold anything.
    const junk = {
      top: {
        hits: {
          hits: [
            {
              _source: {
                pmid: "3",
                title: "Junk role",
                wcmAuthors: [{ cwid: "x", role: "senior" }], // the FACET's vocabulary, not ours
              },
            },
          ],
        },
      },
    };
    expect(parseReasonTopHits(junk, 3, "x")[0]).not.toHaveProperty("role");
  });
});

describe("fetchKeyPaper (lazy key paper)", () => {
  it("returns up to 3 RepresentativePubs with highlighted titles", async () => {
    captured.length = 0;
    const pubs = await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno", "Dcyst"],
      contentQuery: "adenocarcinoma",
    });
    expect(pubs).toEqual([
      {
        pmid: "42424242",
        title: "Glandular adenocarcinoma sequencing",
        titleHtml: "Glandular <mark>adenocarcinoma</mark> sequencing",
        year: 2023,
      },
    ]);
  });

  it("scopes the query to ONE scholar and the resolved concept subtree, pool fetch", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno", "Dcyst"],
      contentQuery: "adenocarcinoma",
    });
    const body = captured[0];
    expect(body.size).toBe(50); // pull a pool, then blend-rerank app-side
    const filter = boolOf(body.query).filter;
    expect(filter).toContainEqual({ term: { wcmAuthorCwids: "abc1234" } });
    expect(filter).toContainEqual({ terms: { meshDescriptorUi: ["Dadeno", "Dcyst"] } });
  });

  it("#1351 — highlights the resolved concept term (not just the literal query) on a tagged fetch", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno"],
      contentQuery: "pharmacogenomics",
      conceptLabel: "Pharmacogenetics",
    });
    const hl = captured[0].highlight as { highlight_query: { bool: { should: unknown[] } } };
    const should = hl.highlight_query.bool.should;
    // literal query clause stays...
    expect(should.some((s) => JSON.stringify(s).includes("pharmacogenomics"))).toBe(true);
    // ...and the resolved concept term is now marked too.
    expect(should).toContainEqual({ match_phrase: { title: "Pharmacogenetics" } });
  });

  it("#1351 — a concept-only fetch (no literal query) still highlights the concept term", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno"],
      contentQuery: "",
      conceptLabel: "Pharmacogenetics",
    });
    const hl = captured[0].highlight as { highlight_query: { bool: { should: unknown[] } } };
    expect(hl.highlight_query.bool.should).toEqual([
      { match_phrase: { title: "Pharmacogenetics" } },
    ]);
  });

  it("falls back to a free-text scan when no concept resolved", async () => {
    captured.length = 0;
    await fetchKeyPaper({ cwid: "abc1234", descriptorUis: [], contentQuery: "16s rna" });
    const filter = boolOf(captured[0].query).filter;
    expect(filter).toContainEqual({ term: { wcmAuthorCwids: "abc1234" } });
    expect(filter.some((f) => JSON.stringify(f).includes("multi_match"))).toBe(true);
  });

  it("fetches the pool by _score then year, tracks scores, and sources citationCount for the blend", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno"],
      contentQuery: "adenocarcinoma",
    });
    const body = captured[0];
    const sort = body.sort as Array<Record<string, unknown>>;
    expect(sort[0]).toHaveProperty("_score");
    expect((sort[0] as { _score: { order: string } })._score.order).toBe("desc");
    expect(sort[1]).toHaveProperty("year");
    expect(sort).toHaveLength(2); // no citationCount in the fetch sort — impact is in the blend
    expect(body.track_scores).toBe(true); // need _score back even though we sort
    expect(body._source).toContain("citationCount"); // for the blend's impact nudge
  });

  it("injects a keyword-relevance `should` multi_match on the content query", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno"],
      contentQuery: "adenocarcinoma",
    });
    const should = boolOf(captured[0].query).should ?? [];
    expect(should.some((s) => JSON.stringify(s).includes("adenocarcinoma"))).toBe(true);
    expect(should.some((s) => JSON.stringify(s).includes("multi_match"))).toBe(true);
  });

  it("sends a bare bool query (no function_score wrapper — recency moved into the blend)", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno"],
      contentQuery: "adenocarcinoma",
    });
    const q = captured[0].query as { function_score?: unknown; bool?: unknown };
    expect(q.function_score).toBeUndefined();
    expect(q.bool).toBeDefined();
  });

  it("returns [] when there is neither a concept nor a query (nothing to fetch)", async () => {
    captured.length = 0;
    const pubs = await fetchKeyPaper({ cwid: "abc1234", descriptorUis: [], contentQuery: "" });
    expect(pubs).toEqual([]);
    expect(captured).toHaveLength(0); // no OpenSearch round-trip
  });

  it("returns [] when the cwid is empty", async () => {
    const pubs = await fetchKeyPaper({ cwid: "", descriptorUis: ["Dadeno"], contentQuery: "x" });
    expect(pubs).toEqual([]);
  });

  it("#1366 — `exclude` adds a query-level must_not terms clause on pmid (de-dup in the pool, not post-filter)", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "zexcl001",
      descriptorUis: ["Dexcl"],
      contentQuery: "dedup-probe",
      exclude: ["111", "222"],
    });
    const bool = boolOf(captured[0].query) as { must_not?: unknown[] };
    expect(bool.must_not).toContainEqual({ terms: { pmid: ["111", "222"] } });
  });

  it("#1366 — no `exclude` ⇒ no must_not clause (admission identical to before)", async () => {
    captured.length = 0;
    await fetchKeyPaper({ cwid: "znoexcl1", descriptorUis: ["Dnoexcl"], contentQuery: "no-dedup-probe" });
    const bool = boolOf(captured[0].query) as { must_not?: unknown[] };
    expect(bool.must_not).toBeUndefined();
  });

  it("MATCHA_GLOSS_INWORDS — `glossTerms` marks the sponsor's phrasing, admission UNCHANGED", async () => {
    captured.length = 0;
    const args = {
      cwid: "abc1234",
      descriptorUis: ["Dadeno"],
      contentQuery: "adenocarcinoma",
      conceptLabel: "Adenocarcinoma",
    };
    await fetchKeyPaper(args);
    await fetchKeyPaper({ ...args, glossTerms: "durable remission" });
    const [plain, withGloss] = captured;
    const hl = withGloss.highlight as { highlight_query: { bool: { should: unknown[] } } };
    // A THIRD highlight clause — it neither clobbers the literal query nor the concept term.
    expect(hl.highlight_query.bool.should).toEqual([
      { multi_match: { query: "adenocarcinoma", fields: ["title"], operator: "or" } },
      { match_phrase: { title: "Adenocarcinoma" } },
      { multi_match: { query: "durable remission", fields: ["title"], operator: "or" } },
    ]);
    // The redesign's whole claim: a marked title is PROVABLY this scholar's paper under this
    // concept, and that holds only if the gloss cannot touch the admission filter (author +
    // descriptor subtree). If the gloss ever leaks into `filter`, the invariant is gone.
    expect(boolOf(withGloss.query).filter).toEqual(boolOf(plain.query).filter);
    // Nor the rank (`should`/`must_not`), the pool size, or the sort — highlight-only, end to end.
    expect({ ...withGloss, highlight: null }).toEqual({ ...plain, highlight: null });
  });

  it("MATCHA_GLOSS_INWORDS — a gloss-only fetch (no literal query, no concept) still highlights", async () => {
    captured.length = 0;
    await fetchKeyPaper({
      cwid: "abc1234",
      descriptorUis: ["Dadeno"],
      contentQuery: "",
      glossTerms: "durable remission",
    });
    // The gloss must also OPEN the highlight block; without it a concept-tagged fetch whose
    // query and label are both empty sends no `highlight` at all and can never mark anything.
    const hl = captured[0].highlight as { highlight_query: { bool: { should: unknown[] } } };
    expect(hl.highlight_query.bool.should).toEqual([
      { multi_match: { query: "durable remission", fields: ["title"], operator: "or" } },
    ]);
  });

  it("MATCHA_GLOSS_INWORDS — absent / blank / whitespace `glossTerms` ⇒ today's request", async () => {
    captured.length = 0;
    const args = { cwid: "abc1234", descriptorUis: ["Dadeno"], contentQuery: "adenocarcinoma" };
    await fetchKeyPaper(args);
    await fetchKeyPaper({ ...args, glossTerms: "" });
    await fetchKeyPaper({ ...args, glossTerms: "   " });
    expect(captured[1]).toEqual(captured[0]); // dark flag ⇒ byte-identical body
    expect(captured[2]).toEqual(captured[0]); // trimmed to "" ⇒ same
    const hl = captured[0].highlight as { highlight_query: { bool: { should: unknown[] } } };
    expect(hl.highlight_query.bool.should).toHaveLength(1); // literal query only, no gloss clause
  });

  it("MATCHA_GLOSS_INWORDS — `glossTerms` buckets the cache key (the real cache bypasses under VITEST, so assert the key)", async () => {
    capturedCacheKeys.length = 0;
    const args = { cwid: "abc1234", descriptorUis: ["Dadeno"], contentQuery: "adenocarcinoma" };
    await fetchKeyPaper(args);
    await fetchKeyPaper({ ...args, glossTerms: "durable remission" });
    await fetchKeyPaper({ ...args, glossTerms: "minimal residual disease" });
    await fetchKeyPaper({ ...args, glossTerms: "   " });
    // `titleHtml` is part of the cached value, so an unmarked call must never be served a marked
    // result (or one marked with a DIFFERENT sponsor's words).
    expect(capturedCacheKeys[1]).not.toBe(capturedCacheKeys[0]);
    expect(capturedCacheKeys[2]).not.toBe(capturedCacheKeys[1]);
    // ...and a blank gloss lands back on the pre-flag key, so the off-path cache is unchanged.
    expect(capturedCacheKeys[3]).toBe(capturedCacheKeys[0]);
  });
});

describe("rankKeyPaperHitsByBlend — 0.6 relevance / 0.4 recency + small >50-cite boost", () => {
  const NOW = 2026;
  const hit = (score: number, year: number, citationCount = 0) => ({
    _score: score,
    _source: { year, citationCount },
  });

  it("a recent, moderately-relevant paper can outrank an OLD, more-relevant one (not relevance-at-all-costs)", () => {
    const oldTopRel = hit(6, 2002); // rel 1.0, rec ~0.13 → ~0.65
    const recentMidRel = hit(4, 2026); // rel 0.67, rec 1.0 → ~0.80
    const ranked = rankKeyPaperHitsByBlend([oldTopRel, recentMidRel], NOW);
    expect(ranked[0]).toBe(recentMidRel);
  });

  it("the >50-citation boost breaks a relevance+recency tie toward the impactful paper", () => {
    const cited = hit(5, 2022, 100); // >50 → +0.05
    const uncited = hit(5, 2022, 10); // identical rel + recency, no boost
    const ranked = rankKeyPaperHitsByBlend([uncited, cited], NOW);
    expect(ranked[0]).toBe(cited);
  });

  it("ranks purely by recency when there is no keyword signal (maxScore 0)", () => {
    const older = hit(0, 2010);
    const newer = hit(0, 2026);
    const ranked = rankKeyPaperHitsByBlend([older, newer], NOW);
    expect(ranked[0]).toBe(newer);
  });

  it("is order-stable and non-mutating", () => {
    const a = hit(5, 2024);
    const b = hit(5, 2024);
    const input = [a, b];
    const ranked = rankKeyPaperHitsByBlend(input, NOW);
    expect(ranked[0]).toBe(a); // equal blend → original order preserved
    expect(input).toEqual([a, b]); // input array untouched
  });
});
