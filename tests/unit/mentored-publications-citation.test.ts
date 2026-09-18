/**
 * `lib/edit/mentored-publications-citation.ts` — the one-line Vancouver
 * citation the report's Publications view prints from a bridge
 * `CoPublicationFull`, plus the shared author-list helpers it leans on
 * (`lib/citation.ts`): six authors then `et al`, `Last FM` tokens, title
 * markup and trailing period stripped, `year;vol(issue):pages`, the literal
 * "NULL" volume treated as absent. Pure — no DB. Synthetic CWIDs only.
 */
import { describe, expect, it } from "vitest";

import type { CoPublicationFull } from "@/lib/api/mentoring";
import { vancouverAuthorList, vancouverAuthorToken } from "@/lib/citation";
import { mentoredPubCitation } from "@/lib/edit/mentored-publications-citation";

const author = (rank: number, lastName: string, firstName: string | null) => ({
  rank,
  lastName,
  firstName,
  personIdentifier: rank === 1 ? "abc1234" : null,
});

function pub(over: Partial<CoPublicationFull> = {}): CoPublicationFull {
  return {
    pmid: 38670054,
    title: "Klotho and clinical outcomes in chronic kidney disease.",
    journal: "Am J Kidney Dis",
    year: 2024,
    doi: null,
    pmcid: null,
    volume: "83",
    issue: "4",
    pages: "500-510",
    citationCount: 0,
    abstract: null,
    authors: [author(1, "Smith", "Jane Ann"), author(2, "Jones", "b"), author(3, "Lee", null)],
    ...over,
  };
}

describe("vancouverAuthorToken / vancouverAuthorList", () => {
  it("Last FM: first letter of each given name, upper-cased, no periods; no given name → last alone", () => {
    expect(vancouverAuthorToken({ lastName: "Smith", firstName: "Jane Ann" })).toBe("Smith JA");
    expect(vancouverAuthorToken({ lastName: "Jones", firstName: "b" })).toBe("Jones B");
    expect(vancouverAuthorToken({ lastName: "Lee", firstName: null })).toBe("Lee");
  });

  it("six authors then et al; exactly six is not truncated; none → empty", () => {
    const many = Array.from({ length: 7 }, (_, i) => author(i + 1, `A${i + 1}`, "X"));
    expect(vancouverAuthorList(many)).toBe("A1 X, A2 X, A3 X, A4 X, A5 X, A6 X, et al");
    expect(vancouverAuthorList(many.slice(0, 6))).toBe("A1 X, A2 X, A3 X, A4 X, A5 X, A6 X");
    expect(vancouverAuthorList([])).toBe("");
  });
});

describe("mentoredPubCitation", () => {
  it("authors. title. journal. year;vol(issue):pages.", () => {
    expect(mentoredPubCitation(pub())).toBe(
      "Smith JA, Jones B, Lee. Klotho and clinical outcomes in chronic kidney disease. Am J Kidney Dis. 2024;83(4):500-510.",
    );
  });

  it("strips inline PubMed markup from the title and treats a literal NULL vol/issue/pages as absent", () => {
    expect(
      mentoredPubCitation(
        pub({
          title: "H<sub>2</sub>O and <i>E. coli</i>",
          volume: "NULL",
          issue: "NULL",
          pages: "NULL",
        }),
      ),
    ).toBe("Smith JA, Jones B, Lee. H2O and E. coli. Am J Kidney Dis. 2024.");
  });

  it("omits what is missing: no journal, no year, no authors", () => {
    expect(mentoredPubCitation(pub({ journal: null, year: null, authors: [] }))).toBe(
      "Klotho and clinical outcomes in chronic kidney disease.",
    );
  });
});
