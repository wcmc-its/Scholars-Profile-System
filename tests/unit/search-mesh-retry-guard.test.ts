/**
 * #1972 — route-level coverage for the #692 §4.1 generic-strip retry ACCEPTANCE rule.
 *
 * The helpers (`meshRetryIsSameDescriptorUpgrade`, `isAllDeprioritized`) are unit-tested
 * in mesh-match-tier.test.ts, but testing them alone does NOT protect the behavior: a
 * mutation that drops the filler-window bypass at the call site leaves the whole suite
 * green while regressing `cancer research` from `Neoplasms` to `Research`. These tests
 * drive the real route so the composition is what is asserted.
 *
 * Both fixtures are real staging measurements (2026-07-26), taken with the retry
 * neutralised (`<q> zzzqqx`) to expose each query's raw full-query resolution.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { DESCENDANT_HARD_CAP, type TaxonomyMatchResult } from "@/lib/api/search-taxonomy";
import {
  meshConfidenceRank,
  MESH_RANK_VERBATIM,
  meshRetryIsSameDescriptorUpgrade,
  meshStripRemovedAtMostHalf,
  meshRetryDroppedWordUnrelated,
} from "@/lib/search";
import { stripDeprioritized, isAllDeprioritized } from "@/lib/api/deprioritized-terms";
import { resolveGenericTermMode } from "@/lib/api/search-flags";

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: { groupBy: vi.fn().mockResolvedValue([]) },
    topic: { findMany: vi.fn().mockResolvedValue([]) },
    subtopic: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    meshDescriptor: { findMany: vi.fn().mockResolvedValue([]) },
    etlRun: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/lib/api/search", () => ({
  searchPeople: vi.fn(async () => ({
    hits: [],
    total: 0,
    page: 0,
    pageSize: 20,
    facets: {
      deptDivs: [],
      personTypes: [],
      activity: { hasGrants: 0, recentPub: 0 },
    },
  })),
  searchPublications: vi.fn(async () => ({ hits: [], total: 0, page: 0, pageSize: 20 })),
  getConceptScholarConcentration: vi.fn(async () => null),
}));

/** Minimal `MeshResolution`; only the fields the guard reads carry meaning. */
function mesh(
  descriptorUi: string,
  name: string,
  matchedForm: string,
  confidence: "exact" | "entry-term" | "partial",
  /** #2094 — total expansion size (self at index 0). Only the LENGTH matters:
   *  the route derives `descendantTruncated` from it. */
  descendantCount = 1,
  /** #1980 fix (2) — `meshRetryDroppedWordUnrelated` reads this alongside `name`. */
  entryTerms: string[] = [],
) {
  return {
    descriptorUi,
    name,
    matchedForm,
    confidence,
    scopeNote: null,
    entryTerms,
    curatedTopicAnchors: [],
    descendantUis: [
      descriptorUi,
      ...Array.from({ length: descendantCount - 1 }, (_, i) => `${descriptorUi}d${i}`),
    ],
  };
}

// Keyed by the query the resolver is called with — the full query first, then the
// generic-stripped retry. Mirrors the measured staging values.
const RESOLUTIONS: Record<string, ReturnType<typeof mesh> | null> = {
  // Filler window: the size-1 arm needs an exact descriptor NAME, so the entry-term
  // `cancer` is skipped and `research` wins. The retry MUST be allowed to replace it.
  "cancer research": mesh("D012106", "Research", "research", "partial"),
  // #2094 — Neoplasms is the canonical truncated descriptor: 702 true descendants
  // (docs/spec-snapshots/mesh-broad-descriptors-2026-05.json), so the real walk
  // returns exactly DESCENDANT_HARD_CAP entries. Sized to match.
  cancer: mesh("D009369", "Neoplasms", "cancer", "entry-term", DESCENDANT_HARD_CAP),
  // Content window: `stem` is not a deprioritized term, so this IS an interpretation.
  // The retry resolves the bare token `stem` and MUST NOT replace it.
  "stem cells effects": mesh("D013234", "Stem Cells", "stem cells", "partial"),
  stem: mesh("D018112", "Microscopy, Electron, Scanning Transmission", "stem", "entry-term"),
  // #1980 — the PROD shape. Prod runs SEARCH_MESH_RESOLUTION_FALLBACK=off, so a query
  // like these resolves to NOTHING (absent from this map ⇒ the mock returns null) and
  // control takes the `current === null` arm, which #1972 leaves unguarded. Only the
  // stripped forms resolve.
  kidney: mesh("D007668", "Kidney", "kidney", "exact"),
  asthma: mesh("D001249", "Asthma", "asthma", "exact"),
  // #1980 fix (2) — real staging measurements (2026-07-31), strip removes exactly HALF
  // the typed tokens (same ratio as the admitted `asthma patients` / `cancer research`
  // wins above), so `stripKeptEnough` admits both, yet both land on the wrong,
  // dropped-word-disjoint concept. `meshRetryDroppedWordUnrelated` must reject them.
  "public policy": mesh("D011640", "Public Policy", "public policy", "exact"),
  "coronary artery": mesh(
    "D003331",
    "Coronary Vessels",
    "coronary artery",
    "entry-term",
  ),
  // Synthetic positive: a multi-word retry whose descriptor DOES share a content token
  // with the dropped word (via an entry term) — the guard must ADMIT this one, proving
  // it rejects on disjointness, not merely on the retry being multi-word.
  "kidney artery": mesh(
    "D0KIDART",
    "Renal Artery",
    "kidney artery",
    "entry-term",
    1,
    ["Renal Artery Disease"],
  ),
};

vi.mock("@/lib/api/search-taxonomy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/search-taxonomy")>();
  const resolve = async (q: string) => RESOLUTIONS[q.trim().toLowerCase()] ?? null;
  const matchQueryToTaxonomy = async (q: string): Promise<TaxonomyMatchResult> => ({
    state: "none" as const,
    meshResolution: await resolve(q),
  });
  return {
    ...actual,
    resolveMeshDescriptor: vi.fn(resolve),
    matchQueryToTaxonomy: vi.fn(matchQueryToTaxonomy),
    // Issue #2115 — `resolveQueryTaxonomy` (the real, extracted composition) calls
    // `matchQueryToTaxonomy` as a bare in-module reference, which a `vi.mock` of
    // this same module cannot intercept (self-calls bypass the mocked export).
    // Reproduce its composition here against the mocked `matchQueryToTaxonomy`
    // above, using the REAL (unmocked) guard helpers — so the #1972/#1980 rules
    // under test still run for real; only the underlying resolution lookup is
    // fixture-driven. `resolveQueryTaxonomy`'s own implementation is covered
    // directly (DB-mocked, not module-mocked) in search-taxonomy.test.ts.
    resolveQueryTaxonomy: vi.fn(async (q: string) => {
      const genericTermMode = resolveGenericTermMode();
      const { contentQuery, removed: genericRemoved } = stripDeprioritized(q);
      const genericStripped = genericTermMode !== "off" && genericRemoved.length > 0;
      const stripKeptEnough = meshStripRemovedAtMostHalf(
        genericRemoved.length,
        q.trim().split(/\s+/).filter(Boolean).length,
      );
      let taxonomyMatch = await matchQueryToTaxonomy(q);
      if (
        genericStripped &&
        taxonomyMatch.state === "none" &&
        meshConfidenceRank(taxonomyMatch.meshResolution?.confidence) < MESH_RANK_VERBATIM
      ) {
        const retry = await matchQueryToTaxonomy(contentQuery);
        const current = taxonomyMatch.meshResolution;
        if (current === null || isAllDeprioritized(current.matchedForm)) {
          if (
            stripKeptEnough &&
            !meshRetryDroppedWordUnrelated(contentQuery, genericRemoved, retry.meshResolution) &&
            (retry.state === "matches" ||
              meshConfidenceRank(retry.meshResolution?.confidence) >
                meshConfidenceRank(current?.confidence))
          ) {
            taxonomyMatch = retry;
          }
        } else if (meshRetryIsSameDescriptorUpgrade(current, retry.meshResolution)) {
          taxonomyMatch = { ...taxonomyMatch, meshResolution: retry.meshResolution };
        }
      }
      return { taxonomyMatch, taxonomyMatchMs: 0 };
    }),
  };
});

async function conceptFor(q: string, type: "people" | "publications") {
  const { GET } = await import("@/app/api/search/route");
  const url = `http://localhost/api/search?type=${type}&q=${encodeURIComponent(q)}`;
  const res = await GET(new NextRequest(url));
  const body = await res.json();
  return body.searchInterpretation ?? {};
}

describe("#1972 — the strip retry may replace a FILLER window but not a CONTENT one", () => {
  beforeEach(() => {
    // The retry is inert unless generic-term stripping is active.
    process.env.SEARCH_GENERIC_TERM_DEMOTE = "resolve";
  });
  afterEach(() => {
    delete process.env.SEARCH_GENERIC_TERM_DEMOTE;
    vi.resetModules();
  });

  // Both branches: the people/SSR path and the mesh-only (#1406) path.
  for (const type of ["people", "publications"] as const) {
    it(`${type}: a pure-filler window is REPLACED — cancer research → Neoplasms`, async () => {
      const i = await conceptFor("cancer research", type);
      expect(i.conceptLabel).toBe("Neoplasms");
      expect(i.meshConfidence).toBe("entry-term");
    });

    it(`${type}: a content window is KEPT — stem cells effects stays Stem Cells`, async () => {
      const i = await conceptFor("stem cells effects", type);
      expect(i.conceptLabel).toBe("Stem Cells");
      // Not "Microscopy, Electron, Scanning Transmission", which is what the bare
      // token `stem` resolves to and what an unguarded retry would adopt.
      expect(i.conceptLabel).not.toMatch(/Microscopy/);
    });
  }
});

/**
 * #1980 — the arm #1972 leaves open: the full query resolved NOTHING, so there is no
 * incumbent concept to protect and the retry is adopted whatever it names.
 *
 * This is the PROD configuration, and it is why the `stem cells effects` case above is
 * green while prod serves "Microscopy, Electron, Scanning Transmission": that fixture
 * gives the full query a `partial` resolution, which only exists when
 * SEARCH_MESH_RESOLUTION_FALLBACK is ON. Prod runs it off, the full query returns null,
 * and this arm — not the same-descriptor arm — is the one that fires.
 */
describe("#1980 — an over-aggressive strip may not be adopted on the null arm", () => {
  beforeEach(() => {
    process.env.SEARCH_GENERIC_TERM_DEMOTE = "resolve";
  });
  afterEach(() => {
    delete process.env.SEARCH_GENERIC_TERM_DEMOTE;
    vi.resetModules();
  });

  for (const type of ["people", "publications"] as const) {
    it(`${type}: 2-of-3 tokens stripped is REJECTED — kidney disease effects stays unresolved`, async () => {
      const i = await conceptFor("kidney disease effects", type);
      // Without the guard the bare token `kidney` is adopted and the card states, with no
      // hedging, that the results are about the ORGAN rather than Kidney Diseases.
      expect(i.conceptLabel ?? null).toBeNull();
    });

    it(`${type}: 1-of-2 tokens stripped is still ADMITTED — asthma patients → Asthma`, async () => {
      const i = await conceptFor("asthma patients", type);
      // The 2→1 class is #1972's 49 measured same-descriptor wins; the guard counts what
      // was REMOVED precisely so this stays admitted.
      expect(i.conceptLabel).toBe("Asthma");
    });
  }
});

/**
 * #1980 fix (2) — the residual rows `stripKeptEnough` cannot reach: both strip exactly
 * HALF their typed tokens (the same ratio the 2→1 class above is admitted at), so the
 * token-budget guard alone admits both, and the retry's own descriptor is disjoint from
 * the word the strip dropped.
 */
describe("#1980 fix (2) — a multi-word retry disjoint from the dropped word is REJECTED", () => {
  beforeEach(() => {
    process.env.SEARCH_GENERIC_TERM_DEMOTE = "resolve";
  });
  afterEach(() => {
    delete process.env.SEARCH_GENERIC_TERM_DEMOTE;
    vi.resetModules();
  });

  for (const type of ["people", "publications"] as const) {
    it(`${type}: public health policy stays unresolved (not Public Policy)`, async () => {
      const i = await conceptFor("public health policy", type);
      // Without fix (2), the strip drops only `health` (1 of 3) and the retry adopts
      // `Public Policy` — neither its name nor entry terms contain `health`, the word
      // that would have made it `Health Policy`.
      expect(i.conceptLabel ?? null).toBeNull();
    });

    it(`${type}: coronary artery disease patients stays unresolved (not Coronary Vessels)`, async () => {
      const i = await conceptFor("coronary artery disease patients", type);
      // Strips `disease` and `patients` (2 of 4, exactly half); the retry's `Coronary
      // Vessels` shares no token with either dropped word.
      expect(i.conceptLabel ?? null).toBeNull();
    });

    it(`${type}: a multi-word retry that DOES share a dropped token is still admitted`, async () => {
      const i = await conceptFor("kidney artery disease", type);
      // `disease` is dropped, but the retry's descriptor entry term ("Renal Artery
      // Disease") contains it — proving the guard rejects on disjointness, not merely
      // because the retry happens to be multi-word.
      expect(i.conceptLabel).toBe("Renal Artery");
    });
  }
});

/**
 * #2094 — descendant-expansion instrumentation. `computeDescendants` early-returns
 * the moment the list reaches DESCENDANT_HARD_CAP, so a set AT the cap means the
 * subtree was cut short and every count derived from it undercounts. The route
 * exposes that on `searchInterpretation` so the truncation rate is one curl per
 * query. These assertions fail if the fields stop being emitted, stop counting the
 * descriptor itself, or stop tracking the cap.
 */
describe("#2094 — searchInterpretation reports the descendant-set size and truncation", () => {
  beforeEach(() => {
    process.env.SEARCH_GENERIC_TERM_DEMOTE = "resolve";
  });
  afterEach(() => {
    delete process.env.SEARCH_GENERIC_TERM_DEMOTE;
    vi.resetModules();
  });

  for (const type of ["people", "publications"] as const) {
    it(`${type}: a capped expansion reports truncated — cancer research → Neoplasms`, async () => {
      const i = await conceptFor("cancer research", type);
      expect(i.conceptLabel).toBe("Neoplasms");
      expect(i.descendantCount).toBe(DESCENDANT_HARD_CAP);
      expect(i.descendantTruncated).toBe(true);
    });

    it(`${type}: a small expansion reports the real size, untruncated — asthma patients`, async () => {
      const i = await conceptFor("asthma patients", type);
      // Self-only set: the count INCLUDES the descriptor at index 0, so 1, not 0.
      expect(i.descendantCount).toBe(1);
      expect(i.descendantTruncated).toBe(false);
    });

    it(`${type}: no resolution reports a null count and no truncation`, async () => {
      const i = await conceptFor("kidney disease effects", type);
      expect(i.conceptLabel ?? null).toBeNull();
      expect(i.descendantCount).toBeNull();
      expect(i.descendantTruncated).toBe(false);
    });
  }
});
