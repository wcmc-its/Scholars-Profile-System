/**
 * The publications export must emit the COMPLETE author byline (#2581).
 *
 * `Publication.authorsString` is the truncated byline and `fullAuthorsString`
 * the untruncated one — a distinction `lib/api/core-queue.ts` documents but the
 * export did not observe: it selected and emitted `authorsString` alone, under a
 * comment calling it "the raw PubMed byline".
 *
 * A prod census sized the damage: of 193,662 publications carrying both fields,
 * the truncated one is shorter on 76,232 (39.4%), dropping 3.68 authors on
 * average and up to 1,264 on the worst row. So a downloaded CSV silently lost
 * co-authors — the whole point of the export for anyone counting collaborators.
 *
 * Both projections (article-granularity and authorship-granularity) are covered,
 * because each does its own `stripBrackets(...)` call on its own row shape.
 */
import { describe, expect, it, vi } from "vitest";

const FIXTURE_PMID = "12345678";

/** The tail this fixture's truncated byline drops — the assertion target. */
const DROPPED_TAIL = "Nakamura Y, Okonkwo B";
const TRUNCATED_AUTHORS = "Ainsworth Q, Belhadj R, Castellanos M";
const FULL_AUTHORS = `${TRUNCATED_AUTHORS}, ${DROPPED_TAIL}`;

vi.mock("@/lib/db", () => ({
  prisma: {
    suppression: { findMany: vi.fn(async () => []) },
    publication: {
      findMany: vi.fn(async () => [
        {
          pmid: FIXTURE_PMID,
          title: "A study with more authors than the byline column holds",
          year: 2024,
          journal: "Journal of Test Fixtures",
          doi: "10.1000/fixture",
          pmcid: null,
          dateAddedToEntrez: null,
          citationCount: 3,
          publicationType: "Journal Article",
          authorsString: TRUNCATED_AUTHORS,
          fullAuthorsString: FULL_AUTHORS,
          authors: [
            {
              isFirst: true,
              isLast: false,
              isPenultimate: false,
              totalAuthors: 5,
              scholar: {
                cwid: "abc1234",
                preferredName: "Ainsworth Quinn",
                primaryDepartment: "Medicine",
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
      return { body: { hits: { hits: [{ _source: { pmid: FIXTURE_PMID } }] } } };
    },
  }),
}));

describe("publications export — untruncated author byline (#2581)", () => {
  it("article rows carry the full byline, not the truncated one", async () => {
    const { fetchArticleRows } = await import("@/lib/api/export-publications");
    const rows = await fetchArticleRows({ q: "" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authors).toBe(FULL_AUTHORS);
    // The specific failure this guards: the tail silently missing.
    expect(rows[0]!.authors).toContain(DROPPED_TAIL);
  });

  it("authorship rows carry the full byline, not the truncated one", async () => {
    const { fetchAuthorshipRows } = await import("@/lib/api/export-publications");
    const rows = await fetchAuthorshipRows({ q: "" });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.authors).toBe(FULL_AUTHORS);
      expect(row.authors).toContain(DROPPED_TAIL);
    }
  });
});
