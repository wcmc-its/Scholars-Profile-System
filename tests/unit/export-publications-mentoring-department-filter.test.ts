/**
 * Issue #1025 — the Publications-tab Export must carry the Mentoring-activity
 * (`mentoringPrograms`) and Department (`department`) facets through to the
 * OpenSearch query, exactly as the live results page does. Before the fix
 * both facets fell out and the export returned the whole corpus.
 *
 * Three layers are covered:
 *   1. `parseBody` (via the POST route) keeps valid `mentoringPrograms` keys
 *      and drops invalid ones, forwarding the parsed filters to the fetcher.
 *   2. `fetchExportPmids` (CSV path) emits `{ terms: { pmid: [...] } }` when
 *      the mentoring bucket union is non-empty, `{ match_none: {} }` when the
 *      union is empty, and `{ terms: { wcmAuthorDepartments: [...] } }` when a
 *      department filter is set.
 *   3. The Word-bibliography query builder emits the same clauses.
 *
 * `getMentoringPmidBuckets` is mocked to a known `byProgram` map; the
 * OpenSearch client is mocked the same way the existing export/search tests do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Known bucket map: md/phd carry pmids, the rest are empty so we can assert the
// empty-union → match_none branch.
const BUCKETS = {
  all: ["100", "200", "300"],
  byProgram: {
    md: ["100", "200"],
    mdphd: [],
    phd: ["300"],
    postdoc: [],
    ecr: [],
  },
};

vi.mock("@/lib/api/mentoring-pmids", () => ({
  getMentoringPmidBuckets: vi.fn(async () => BUCKETS),
}));

// The export route now gates on an internal viewer; treat the POST caller as an
// authenticated session so the parseBody assertions still reach the 200 path.
vi.mock("@/lib/auth/viewer-context", () => ({
  resolveViewerContext: vi.fn(async () => ({
    internal: true,
    basis: "session",
    cwid: "test1234",
  })),
}));

// Capture every OpenSearch body the query builders send.
const capturedBodies: Array<Record<string, unknown>> = [];

vi.mock("@/lib/search", () => ({
  PUBLICATIONS_INDEX: "scholars-publications",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  PUBLICATION_FIELD_BOOSTS_ARRAY: ["title^1"],
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
      return { body: { hits: { hits: [] } } };
    },
  }),
}));

// Prisma is never reached (zero pmids returned), but the module imports it.
vi.mock("@/lib/db", () => ({
  prisma: {
    publication: { findMany: vi.fn(async () => []) },
    scholar: { findMany: vi.fn(async () => []) },
  },
}));

type BoolFilter = Array<Record<string, unknown>>;

function filterClauses(body: Record<string, unknown>): BoolFilter {
  const query = body.query as { bool?: { filter?: BoolFilter } };
  return query.bool?.filter ?? [];
}

/** The single-arg fetcher signature the route delegates to; lets the route
 *  test read back the parsed `filters` the route forwarded. */
type ExportReqArg = { filters: { mentoringPrograms?: string[] } };
const rowFetcher = () => vi.fn(async (_req: ExportReqArg) => [] as unknown[]);

beforeEach(() => {
  capturedBodies.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("#1025 — parseBody keeps valid mentoringPrograms, drops invalid keys", () => {
  it("forwards the allowlisted program keys to the fetcher and drops junk", async () => {
    vi.resetModules();

    const fetchArticleRows = rowFetcher();
    const fetchAuthorshipRows = rowFetcher();
    vi.doMock("@/lib/api/export-publications", () => ({
      EXPORT_MAX_LIMIT: 5000,
      AUTHORSHIP_HEADERS: ["pmid"],
      ARTICLE_HEADERS: ["pmid"],
      fetchArticleRows,
      fetchAuthorshipRows,
    }));
    vi.doMock("@/lib/api/word-bibliography", () => ({
      WORD_MAX_LIMIT: 1000,
      generateWordBibliography: vi.fn(),
    }));

    const { POST } = await import(
      "@/app/api/export/publications/[granularity]/route"
    );

    const req = new NextRequest(
      "http://localhost/api/export/publications/article",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          q: "",
          filters: {
            // valid + invalid mixed; "bogus"/"phd2" must be dropped.
            mentoringPrograms: ["md", "bogus", "phd", "phd2", "postdoc"],
          },
        }),
      },
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await POST(req, {
      params: Promise.resolve({ granularity: "article" }),
    });
    expect(res.status).toBe(200);

    expect(fetchArticleRows).toHaveBeenCalledTimes(1);
    const passed = fetchArticleRows.mock.calls[0]![0];
    expect(passed.filters.mentoringPrograms).toEqual(["md", "phd", "postdoc"]);

    vi.doUnmock("@/lib/api/export-publications");
    vi.doUnmock("@/lib/api/word-bibliography");
  });

  it("omits mentoringPrograms entirely when every key is invalid", async () => {
    vi.resetModules();

    const fetchArticleRows = rowFetcher();
    vi.doMock("@/lib/api/export-publications", () => ({
      EXPORT_MAX_LIMIT: 5000,
      AUTHORSHIP_HEADERS: ["pmid"],
      ARTICLE_HEADERS: ["pmid"],
      fetchArticleRows,
      fetchAuthorshipRows: rowFetcher(),
    }));
    vi.doMock("@/lib/api/word-bibliography", () => ({
      WORD_MAX_LIMIT: 1000,
      generateWordBibliography: vi.fn(),
    }));

    const { POST } = await import(
      "@/app/api/export/publications/[granularity]/route"
    );

    const req = new NextRequest(
      "http://localhost/api/export/publications/article",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          q: "",
          filters: { mentoringPrograms: ["bogus", "phd2"] },
        }),
      },
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    await POST(req, { params: Promise.resolve({ granularity: "article" }) });

    const passed = fetchArticleRows.mock.calls[0]![0];
    expect(passed.filters.mentoringPrograms).toBeUndefined();

    vi.doUnmock("@/lib/api/export-publications");
    vi.doUnmock("@/lib/api/word-bibliography");
  });
});

describe("#1025 — fetchExportPmids applies mentoring + department clauses", () => {
  it("emits { terms: { pmid: [...] } } for a non-empty mentoring union", async () => {
    const { fetchArticleRows } = await import("@/lib/api/export-publications");
    // md ∪ phd = [100, 200, 300]
    await fetchArticleRows({
      q: "",
      filters: { mentoringPrograms: ["md", "phd"] },
    });
    const clauses = filterClauses(capturedBodies[0]!);
    expect(clauses).toContainEqual({
      terms: { pmid: ["100", "200", "300"] },
    });
    expect(clauses).not.toContainEqual({ match_none: {} });
  });

  it("emits { match_none: {} } when the mentoring union is empty", async () => {
    const { fetchArticleRows } = await import("@/lib/api/export-publications");
    // mdphd ∪ ecr = [] → match_none, NOT the whole corpus.
    await fetchArticleRows({
      q: "",
      filters: { mentoringPrograms: ["mdphd", "ecr"] },
    });
    const clauses = filterClauses(capturedBodies[0]!);
    expect(clauses).toContainEqual({ match_none: {} });
    expect(
      clauses.some((c) => Object.prototype.hasOwnProperty.call(c, "terms")),
    ).toBe(false);
  });

  it("emits { terms: { wcmAuthorDepartments: [...] } } when department is set", async () => {
    const { fetchArticleRows } = await import("@/lib/api/export-publications");
    await fetchArticleRows({
      q: "",
      filters: { department: ["MED", "PEDS"] },
    });
    const clauses = filterClauses(capturedBodies[0]!);
    expect(clauses).toContainEqual({
      terms: { wcmAuthorDepartments: ["MED", "PEDS"] },
    });
  });

  it("applies both clauses together", async () => {
    const { fetchArticleRows } = await import("@/lib/api/export-publications");
    await fetchArticleRows({
      q: "",
      filters: { department: ["MED"], mentoringPrograms: ["md"] },
    });
    const clauses = filterClauses(capturedBodies[0]!);
    expect(clauses).toContainEqual({ terms: { wcmAuthorDepartments: ["MED"] } });
    expect(clauses).toContainEqual({ terms: { pmid: ["100", "200"] } });
  });
});

describe("#1025 — word-bibliography query builder applies mentoring + department", () => {
  it("emits the pmid union and department clause", async () => {
    const { generateWordBibliography } = await import(
      "@/lib/api/word-bibliography"
    );
    await generateWordBibliography({
      q: "",
      filters: { department: ["MED"], mentoringPrograms: ["md", "phd"] },
    });
    const clauses = filterClauses(capturedBodies[0]!);
    expect(clauses).toContainEqual({ terms: { wcmAuthorDepartments: ["MED"] } });
    expect(clauses).toContainEqual({ terms: { pmid: ["100", "200", "300"] } });
  });

  it("emits match_none for an empty mentoring union", async () => {
    const { generateWordBibliography } = await import(
      "@/lib/api/word-bibliography"
    );
    await generateWordBibliography({
      q: "",
      filters: { mentoringPrograms: ["postdoc"] },
    });
    const clauses = filterClauses(capturedBodies[0]!);
    expect(clauses).toContainEqual({ match_none: {} });
  });
});
