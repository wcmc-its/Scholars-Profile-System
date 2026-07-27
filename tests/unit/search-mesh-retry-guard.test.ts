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
) {
  return {
    descriptorUi,
    name,
    matchedForm,
    confidence,
    scopeNote: null,
    entryTerms: [],
    curatedTopicAnchors: [],
    descendantUis: [descriptorUi],
  };
}

// Keyed by the query the resolver is called with — the full query first, then the
// generic-stripped retry. Mirrors the measured staging values.
const RESOLUTIONS: Record<string, ReturnType<typeof mesh> | null> = {
  // Filler window: the size-1 arm needs an exact descriptor NAME, so the entry-term
  // `cancer` is skipped and `research` wins. The retry MUST be allowed to replace it.
  "cancer research": mesh("D012106", "Research", "research", "partial"),
  cancer: mesh("D009369", "Neoplasms", "cancer", "entry-term"),
  // Content window: `stem` is not a deprioritized term, so this IS an interpretation.
  // The retry resolves the bare token `stem` and MUST NOT replace it.
  "stem cells effects": mesh("D013234", "Stem Cells", "stem cells", "partial"),
  stem: mesh("D018112", "Microscopy, Electron, Scanning Transmission", "stem", "entry-term"),
};

vi.mock("@/lib/api/search-taxonomy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/search-taxonomy")>();
  const resolve = async (q: string) => RESOLUTIONS[q.trim().toLowerCase()] ?? null;
  return {
    ...actual,
    resolveMeshDescriptor: vi.fn(resolve),
    matchQueryToTaxonomy: vi.fn(async (q: string) => ({
      state: "none" as const,
      meshResolution: await resolve(q),
    })),
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
