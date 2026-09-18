/**
 * #2653 v8 — product references (`lib/edit/biosketch-references.ts`): lead-author derivation,
 * the keyed list, the prompt block, and the post-parse validator (render in-list keys, strip
 * out-of-list keys / PMIDs / URLs, flag out-of-list author-year parentheticals and full-citation
 * tells without editing them, tidy what a strip leaves behind).
 * Pure module; no mocks.
 */
import { describe, expect, it } from "vitest";

import {
  buildProductReferencePrompt,
  leadAuthorSurname,
  productReferenceList,
  scanReferenceIssues,
  stripProductKeys,
  validateProductReferences,
  type BiosketchProductRef,
} from "@/lib/edit/biosketch-references";
import type { BiosketchProducts } from "@/lib/edit/biosketch-products";

const product = (pmid: string, title: string, year: number | null) => ({
  pmid,
  title,
  venue: null,
  year,
  contributionIndex: null,
  why: "",
});

const PRODUCTS: BiosketchProducts = {
  related: [product("11", "Alpha study", 2019), product("22", "Beta <i>trial</i>", 2021)],
  otherSignificant: [product("33", "Gamma cohort", null), product("11", "dup of alpha", 2019)],
  relatedFromAims: true,
};

const PUBS = [
  { pmid: "11", leadAuthor: "Smith" },
  { pmid: "22", leadAuthor: null },
  { pmid: "33", leadAuthor: "Lee" },
];

describe("leadAuthorSurname", () => {
  it("takes the first author's surname, dropping trailing initials", () => {
    expect(leadAuthorSurname("Smith AB, Jones C, Lee D")).toBe("Smith");
    expect(leadAuthorSurname("van der Berg AB, Jones C")).toBe("van der Berg");
    expect(leadAuthorSurname("O'Brien PJ")).toBe("O'Brien");
    expect(leadAuthorSurname("Kim J-H, Park S")).toBe("Kim");
  });

  it("unwraps the WCM ((…)) hyperlink marker and tolerates a bare surname", () => {
    expect(leadAuthorSurname("((Smith AB)), Jones C")).toBe("Smith");
    expect(leadAuthorSurname("Smith")).toBe("Smith");
  });

  it("returns null for nothing usable", () => {
    expect(leadAuthorSurname(null)).toBeNull();
    expect(leadAuthorSurname("")).toBeNull();
    expect(leadAuthorSurname("  ,  ")).toBeNull();
  });
});

describe("productReferenceList", () => {
  it("keys related then other-significant, one key per pmid, with the NIH label", () => {
    const refs = productReferenceList(PRODUCTS, PUBS);
    expect(refs.map((r) => [r.key, r.pmid, r.label])).toEqual([
      ["P1", "11", "Smith 2019"],
      ["P2", "22", "PMID 22"], // no lead author → PMID form
      ["P3", "33", "PMID 33"], // no year → PMID form
    ]);
    // the duplicate pmid in the other bucket is not re-keyed
    expect(refs.length).toBe(3);
  });

  it("is empty for empty buckets", () => {
    expect(
      productReferenceList({ related: [], otherSignificant: [], relatedFromAims: false }, PUBS),
    ).toEqual([]);
  });
});

describe("buildProductReferencePrompt", () => {
  it("lists each key with its rendered form and title; empty string for no refs", () => {
    const block = buildProductReferencePrompt(productReferenceList(PRODUCTS, PUBS));
    expect(block).toContain("[P1] renders as (Smith 2019): Alpha study (2019)");
    expect(block).toContain("[P2] renders as (PMID 22): Beta <i>trial</i> (2021)");
    expect(block).toContain("[P3] renders as (PMID 33): Gamma cohort");
    expect(buildProductReferencePrompt([])).toBe("");
  });
});

describe("validateProductReferences", () => {
  const refs: BiosketchProductRef[] = productReferenceList(PRODUCTS, PUBS);

  it("renders in-list keys to the parenthetical form and counts them", () => {
    const { text, report } = validateProductReferences(
      "We showed X [P1]. We then showed Y [P2, P3].",
      refs,
    );
    expect(text).toBe("We showed X (Smith 2019). We then showed Y (PMID 22; PMID 33).");
    expect(report.kept).toBe(3);
    expect(report.issues).toEqual([]);
  });

  it("strips an out-of-list key and keeps the in-list members of a mixed group", () => {
    const { text, report } = validateProductReferences("Claim A [P9]. Claim B [P1, P7].", refs);
    expect(text).toBe("Claim A. Claim B (Smith 2019).");
    expect(report.kept).toBe(1);
    expect(report.issues).toEqual([
      { span: "[P9]", kind: "out_of_list", action: "stripped" },
      { span: "[P1, P7]", kind: "out_of_list", action: "stripped" },
    ]);
  });

  it("normalizes an in-list author-year, flags an out-of-list one in place, strips an out-of-list PMID", () => {
    const { text, report } = validateProductReferences(
      "Known (SMITH 2019) and (Smith et al., 2019); unknown (Jones 2020) and (PMID: 999); listed (PMID 33).",
      refs,
    );
    expect(text).toBe(
      "Known (Smith 2019) and (Smith 2019); unknown (Jones 2020) and; listed (PMID 33).",
    );
    expect(report.kept).toBe(3);
    expect(report.issues).toEqual([
      { span: "(Jones 2020)", kind: "out_of_list", action: "flagged" },
      { span: "(PMID: 999)", kind: "out_of_list", action: "stripped" },
    ]);
  });

  it("never strips a prose parenthetical shaped like author-year; an in-list one is not flagged", () => {
    const input = "Enrollment began (March 2020) after the pilot (Smith 2019) and [P1].";
    const { text, report } = validateProductReferences(input, refs);
    // "(March 2020)" survives verbatim; the in-list forms render and raise no issue.
    expect(text).toBe(
      "Enrollment began (March 2020) after the pilot (Smith 2019) and (Smith 2019).",
    );
    expect(report.kept).toBe(2);
    expect(report.issues).toEqual([
      { span: "(March 2020)", kind: "out_of_list", action: "flagged" },
    ]);
    expect(scanReferenceIssues(input, refs)).toEqual(report.issues);
  });

  it("strips URLs and DOIs, and flags (but does not edit) a full-citation tell", () => {
    const { text, report } = validateProductReferences(
      "See https://example.org/x and doi:10.1000/xyz. Cited as J Clin. 2019;12(3):45-67.",
      refs,
    );
    expect(text).toBe("See and. Cited as J Clin. 2019;12(3):45-67.");
    expect(report.issues.filter((i) => i.kind === "url").map((i) => i.span)).toEqual([
      "https://example.org/x",
      "doi:10.1000/xyz",
    ]);
    const tells = report.issues.filter((i) => i.kind === "full_citation");
    expect(tells.length).toBeGreaterThan(0);
    expect(tells.every((i) => i.action === "flagged")).toBe(true);
  });

  it("never mistakes a gene or phase parenthetical for a key", () => {
    const { text, report } = validateProductReferences("Loss of (P53) and (P1) signaling.", refs);
    expect(text).toBe("Loss of (P53) and (P1) signaling.");
    expect(report.issues).toEqual([]);
  });

  it("with no refs still strips stray keys and URLs", () => {
    const { text, report } = validateProductReferences("A claim [P1] at www.x.org.", []);
    expect(text).toBe("A claim at.");
    expect(report.kept).toBe(0);
    expect(report.issues.map((i) => i.kind)).toEqual(["out_of_list", "url"]);
  });

  it("stripProductKeys drops key groups without rendering them (title lines)", () => {
    expect(stripProductKeys("Alpha vectors [P1] in liver [P2, P3]")).toBe("Alpha vectors in liver");
    expect(stripProductKeys("No keys")).toBe("No keys");
  });

  it("scanReferenceIssues is a pure read of what the validator would do", () => {
    const issues = scanReferenceIssues("X [P1] Y [P8] https://a.b", refs);
    expect(issues).toEqual([
      { span: "[P8]", kind: "out_of_list", action: "stripped" },
      { span: "https://a.b", kind: "url", action: "stripped" },
    ]);
  });
});
