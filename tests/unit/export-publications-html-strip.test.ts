/**
 * CSV exports must not leak PubMed inline HTML into spreadsheet cells
 * (#331). Titles arrive from the DB carrying `<i>BRCA1</i>` and
 * `H<sub>2</sub>O` — `htmlToPlainText` strips them before serialization
 * so users never see a literal `<sup>+</sup>` in Excel.
 *
 * Mocks the OpenSearch `searchClient` (returns a single pmid) and the
 * Prisma client (returns a publication whose title carries `<sup>` /
 * `<i>`). Asserts that both shapes — the article-row projection and the
 * authorship-row projection — emit titles free of `<` / `>`.
 */
import { describe, expect, it, vi } from "vitest";

const FIXTURE_PMID = "29326275";
const TITLE_WITH_HTML =
  "CX3CR1<sup>+</sup> mononuclear phagocytes control immunity to <i>intestinal fungi</i>.";

vi.mock("@/lib/db", () => ({
  prisma: {
    publication: {
      findMany: vi.fn(async () => [
        {
          pmid: FIXTURE_PMID,
          title: TITLE_WITH_HTML,
          year: 2018,
          journal: "Science",
          doi: "10.1126/science.aao1503",
          pmcid: "PMC6005236",
          dateAddedToEntrez: null,
          citationCount: 100,
          publicationType: "Journal Article",
          authorsString: "Leonardi I, Iliev ID",
          authors: [
            {
              isFirst: true,
              isLast: false,
              isPenultimate: false,
              totalAuthors: 2,
              scholar: {
                cwid: "idi2017",
                preferredName: "Iliev Iliyan D",
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
      return {
        body: {
          hits: {
            hits: [{ _source: { pmid: FIXTURE_PMID } }],
          },
        },
      };
    },
  }),
}));

describe("export-publications — strip PubMed HTML from CSV titles (#331)", () => {
  it("article rows emit plain-text titles (no `<` or `>`)", async () => {
    const { fetchArticleRows } = await import("@/lib/api/export-publications");
    const rows = await fetchArticleRows({ q: "" });
    expect(rows).toHaveLength(1);
    const t = rows[0]!.title;
    expect(t).not.toContain("<");
    expect(t).not.toContain(">");
    expect(t).toContain("CX3CR1+ mononuclear phagocytes");
    expect(t).toContain("intestinal fungi");
  });

  it("authorship rows emit plain-text titles (no `<` or `>`)", async () => {
    const { fetchAuthorshipRows } = await import(
      "@/lib/api/export-publications"
    );
    const rows = await fetchAuthorshipRows({ q: "" });
    expect(rows).toHaveLength(1);
    const t = rows[0]!.title;
    expect(t).not.toContain("<");
    expect(t).not.toContain(">");
    expect(t).toContain("CX3CR1+");
  });
});
