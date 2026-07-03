/**
 * The publications authorship export must honor per-author suppression exactly
 * as the search-index build does (`buildPublicationDoc` — lib/search-index-docs.ts):
 * a scholar hidden on a publication (`suppression(publication, pmid, contributorCwid)`)
 * must NOT appear as an authorship row, even though a non-suppressed co-author on
 * the same publication still does. Loaded per request from Aurora, so a hide
 * added since the last nightly reindex is honored immediately.
 *
 * Mocks the OpenSearch `searchClient` (one pmid) and the Prisma client (one
 * publication with two confirmed WCM authors + a configurable suppression set).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PMID = "40000001";
const VISIBLE_CWID = "vis0001";
const HIDDEN_CWID = "hid0002";

vi.mock("@/lib/db", () => ({
  prisma: {
    // loadPublicationSuppressions reads this per request; configured per test.
    suppression: { findMany: vi.fn(async () => []) },
    publication: {
      findMany: vi.fn(async () => [
        {
          pmid: PMID,
          title: "A paper with two WCM authors",
          year: 2021,
          journal: "Nature",
          doi: "10.1038/x",
          pmcid: null,
          dateAddedToEntrez: null,
          citationCount: 10,
          publicationType: "Journal Article",
          authorsString: "Visible A, Hidden B",
          authors: [
            {
              position: 1,
              isFirst: true,
              isLast: false,
              isPenultimate: false,
              totalAuthors: 2,
              scholar: {
                cwid: VISIBLE_CWID,
                preferredName: "Visible Author",
                primaryDepartment: "Medicine",
              },
            },
            {
              position: 2,
              isFirst: false,
              isLast: true,
              isPenultimate: false,
              totalAuthors: 2,
              scholar: {
                cwid: HIDDEN_CWID,
                preferredName: "Hidden Author",
                primaryDepartment: "Surgery",
              },
            },
          ],
        },
      ]),
    },
  },
}));

vi.mock("@/lib/search", () => ({
  PUBLICATIONS_INDEX: "scholars-publications",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  searchClient: () => ({
    async search() {
      return { body: { hits: { hits: [{ _source: { pmid: PMID } }] } } };
    },
  }),
}));

async function suppressionMock() {
  const { prisma } = await import("@/lib/db");
  return vi.mocked(prisma.suppression.findMany);
}

beforeEach(async () => {
  (await suppressionMock()).mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("export-publications — authorship export honors per-author suppression", () => {
  it("omits a suppressed (author, pmid) row while the non-suppressed co-author keeps their row", async () => {
    // Only the fields loadPublicationSuppressions selects; cast past the full
    // Prisma row type the mock's return signature otherwise demands.
    (await suppressionMock()).mockResolvedValue([
      { entityId: PMID, contributorCwid: HIDDEN_CWID },
    ] as never);

    const { fetchAuthorshipRows } = await import("@/lib/api/export-publications");
    const rows = await fetchAuthorshipRows({ q: "" });

    const ids = rows.map((r) => r.personIdentifier);
    expect(ids).toEqual([VISIBLE_CWID]);
    expect(ids).not.toContain(HIDDEN_CWID);
  });

  it("emits both co-authors when no suppression is active (control)", async () => {
    (await suppressionMock()).mockResolvedValue([]);

    const { fetchAuthorshipRows } = await import("@/lib/api/export-publications");
    const rows = await fetchAuthorshipRows({ q: "" });

    const ids = rows.map((r) => r.personIdentifier).sort();
    expect(ids).toEqual([HIDDEN_CWID, VISIBLE_CWID].sort());
  });

  it("emits no rows for a whole-publication takedown (contributorCwid null)", async () => {
    (await suppressionMock()).mockResolvedValue([
      { entityId: PMID, contributorCwid: null },
    ] as never);

    const { fetchAuthorshipRows } = await import("@/lib/api/export-publications");
    const rows = await fetchAuthorshipRows({ q: "" });

    expect(rows).toHaveLength(0);
  });
});
