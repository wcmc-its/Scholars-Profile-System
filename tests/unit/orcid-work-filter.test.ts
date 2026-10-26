/**
 * `etl/orcid-evidence/work-filter` — which ORCID works are publications (ORCID
 * queue v2 spec, item 3): the dropped types, figure / supplement titles on
 * `other` works, Figshare / Zenodo DOIs unless typed journal-article, and
 * preprint versions collapsed onto the published work. Reused by the Phase 2
 * harvest, so every rule is pinned here. Synthetic titles and DOIs.
 */
import { describe, expect, it } from "vitest";

import {
  AACR_SUPPLEMENT_DOI,
  filterPublicationWorks,
  isNonPublicationWork,
  isPreprint,
  NON_PUBLICATION_TYPES,
  titleKey,
  type FilterableWork,
} from "@/etl/orcid-evidence/work-filter";

const w = (
  title: string | null,
  type: string | null,
  doi: string | null = null,
  ids: string[] = doi ? [`doi:${doi}`] : [],
): FilterableWork & { label: string } => ({
  label: title ?? "",
  title,
  type,
  doi,
  ids: new Set(ids),
});

describe("isNonPublicationWork", () => {
  it.each([...NON_PUBLICATION_TYPES])("drops type %s", (type) => {
    expect(isNonPublicationWork(w("A real-looking title about cells", type))).toBe(true);
  });

  it("drops the spec's exact list, and nothing else by type", () => {
    expect([...NON_PUBLICATION_TYPES].sort()).toEqual(
      [
        "conference-abstract",
        "conference-poster",
        "data-set",
        "image",
        "lecture-speech",
        "software",
        "website",
      ].sort(),
    );
    for (const t of ["journal-article", "book", "book-chapter", "preprint", "review"])
      expect(isNonPublicationWork(w("Figure 1", t))).toBe(false);
  });

  it.each([
    "Figure 3",
    "Fig. 2: survival curves",
    "Table S1",
    "Supplementary Material for: A study",
    "Supplemental data",
    "Supporting information",
    "Additional file 1",
    "MOESM1 of a paper",
    "Movie S2",
    "Video 1: the procedure",
    "Appendix A",
    "Appendix S1: search strategy",
    "Supplementary tables",
  ])("drops an `other` or untyped work titled %s", (title) => {
    expect(isNonPublicationWork(w(title, "other"))).toBe(true);
    expect(isNonPublicationWork(w(title, null))).toBe(true);
  });

  it("keeps an `other` work with a paper's title", () => {
    expect(isNonPublicationWork(w("Tables and chairs in the clinic", "other"))).toBe(false);
    expect(isNonPublicationWork(w("Outcomes after transplant", "other"))).toBe(false);
  });

  it.each([
    "Video-assisted thoracoscopic lobectomy outcomes",
    "Appendix cancer: a review",
    "Appendix a review of cases",
    "Figures of merit in imaging",
    "Movie theater injuries",
    "Table manners in pediatric wards",
    "Supplementation with vitamin D in older adults",
    "Supplemental oxygen after surgery",
  ])("keeps an `other` or untyped paper titled %s", (title) => {
    expect(isNonPublicationWork(w(title, "other"))).toBe(false);
    expect(isNonPublicationWork(w(title, null))).toBe(false);
  });

  it("never drops a work that carries a PMID for its title", () => {
    expect(isNonPublicationWork(w("Figure 3", "other", null, ["pmid:12345"]))).toBe(false);
  });

  it("drops a Figshare or Zenodo DOI unless typed journal-article", () => {
    expect(isNonPublicationWork(w("Raw counts", "other", "10.6084/m9.figshare.123"))).toBe(true);
    expect(isNonPublicationWork(w("Model weights", null, "10.5281/zenodo.42"))).toBe(true);
    expect(isNonPublicationWork(w("Model weights", "journal-article", "10.5281/zenodo.42"))).toBe(
      false,
    );
  });
});

describe("v2.1: supplements, whatever the ORCID type", () => {
  it.each([
    "Supplementary Table S1 from Radiodensities of Breast Tissue in Screening",
    "Figure S3 from Deleting Trim33 Alters Myeloid Differentiation",
    "Supplementary Data from Tumor Evolution in Patients",
    "Supplemental Figure 2 from A Phase I Trial",
    "Supplementary Figures S1-S7 from Clonal Hematopoiesis",
    "Supplementary Tables S1\u2013S4 from Clonal Hematopoiesis",
    "Supplementary Methods from Single-Cell Atlas",
    "Table S2 for Germline Variants in Prostate Cancer",
    "Fig. 4 of the Lung Tumor Model",
    "Data S1 from Mouse Models of Leukemia",
    "Movie S1 from Live Imaging of Metastasis",
    "Video 2 from Endoscopic Resection",
    "File S1 from Cohort Characteristics",
    "Appendix S2 from A Randomized Trial",
    "Figure 1a from Spatial Transcriptomics",
  ])("drops %s even when typed journal-article", (title) => {
    expect(isNonPublicationWork(w(title, "journal-article"))).toBe(true);
    expect(isNonPublicationWork(w(title, null))).toBe(true);
  });

  it.each([
    "A Randomized Pilot Trial of Micronutrient Supplementation in Pregnancy",
    "Incidental Detection on CT of Neoplasms of the Appendix",
    "Supplemental oxygen after surgery",
    "Supplemental Nutrition Assistance Program participation for older adults",
    "Supplementation with vitamin D in older adults",
    "Data sharing for clinical trials",
    "Table manners in pediatric wards",
    "Figures of merit in imaging",
  ])("keeps the paper %s", (title) => {
    expect(isNonPublicationWork(w(title, "journal-article"))).toBe(false);
    expect(isNonPublicationWork(w(title, null))).toBe(false);
  });

  it("drops an AACR supplement DOI (10.1158/<issn>.<6+ digits>[.vN]) whatever its type or title", () => {
    for (const d of [
      "10.1158/0008-5472.22412345",
      "10.1158/1078-0432.22487654.v1",
      "10.1158/2159-829X.123456",
    ]) {
      expect(AACR_SUPPLEMENT_DOI.test(d)).toBe(true);
      expect(isNonPublicationWork(w("Untitled deposit", "journal-article", d))).toBe(true);
    }
  });

  it("keeps an AACR article DOI", () => {
    for (const d of [
      "10.1158/0008-5472.CAN-20-1234",
      "10.1158/1078-0432.CCR-19-0001",
      "10.1158/0008-5472.12345",
    ]) {
      expect(AACR_SUPPLEMENT_DOI.test(d)).toBe(false);
      expect(isNonPublicationWork(w("A real paper about tumors", "journal-article", d))).toBe(
        false,
      );
    }
  });

  it("a supplement title on a work that carries a PMID is kept (the PMID says paper)", () => {
    expect(
      isNonPublicationWork(w("Supplementary Table S1 from X", "journal-article", null, ["pmid:9"])),
    ).toBe(false);
  });
});

describe("preprints", () => {
  it("isPreprint: typed preprint, or a preprint server's DOI", () => {
    expect(isPreprint(w("x", "preprint"))).toBe(true);
    expect(isPreprint(w("x", "other", "10.1101/2020.01.01.123456"))).toBe(true);
    expect(isPreprint(w("x", "journal-article", "10.1016/j.cell.2020.01.001"))).toBe(false);
  });

  it("titleKey ignores case, punctuation, accents and a trailing version", () => {
    expect(titleKey("Gene Regulation in Cells: A Study (v2)")).toBe(
      titleKey("gene regulation in cells a study"),
    );
    expect(titleKey("Réponse immunitaire des cellules")).toBe("reponse immunitaire des cellules");
    expect(titleKey("Reply")).toBeNull(); // too short to group on
  });

  it("collapses a preprint into its published twin, which takes the preprint's ids", () => {
    const pre = w("Gene regulation in human cells", "preprint", "10.1101/2020.01.01.111");
    const pub = w("Gene Regulation in Human Cells.", "journal-article", "10.1016/j.x.2021.1", [
      "doi:10.1016/j.x.2021.1",
      "pmid:555",
    ]);
    const { kept, collapsed } = filterPublicationWorks([pre, pub]);
    expect(collapsed).toBe(1);
    expect(kept.map((k) => k.type)).toEqual(["journal-article"]);
    expect([...kept[0]!.ids].sort()).toEqual(
      ["doi:10.1016/j.x.2021.1", "doi:10.1101/2020.01.01.111", "pmid:555"].sort(),
    );
  });

  it("collapses v1 / v2 of a preprint to one, the highest version", () => {
    const v1 = w("A preprint about mice", "preprint", "10.1101/2020.02.02.222v1");
    const v2 = w("A preprint about mice", "preprint", "10.1101/2020.02.02.222v2");
    const { kept } = filterPublicationWorks([v1, v2]);
    expect(kept.map((k) => k.doi)).toEqual(["10.1101/2020.02.02.222v2"]);
    expect(kept[0]!.ids.size).toBe(2);
  });

  it("groups preprint versions by DOI even when the titles changed", () => {
    const v1 = w("Early title of the work", "preprint", "10.1101/2020.03.03.333v1");
    const v2 = w("The final title of this work", "preprint", "10.1101/2020.03.03.333v3");
    expect(filterPublicationWorks([v1, v2]).kept).toHaveLength(1);
  });

  it("never collapses two published works that share a title", () => {
    const a = w("Correction to an earlier article", "journal-article", "10.1/a");
    const b = w("Correction to an earlier article", "journal-article", "10.1/b");
    expect(filterPublicationWorks([a, b]).kept).toHaveLength(2);
  });

  it("drops, then collapses, and keeps the input order", () => {
    const works = [
      w("First paper of the scholar", "journal-article", "10.1/one"),
      w("Figure 1", "other"),
      w("Second paper of the scholar", "preprint", "10.1101/two"),
      w("A poster at the meeting", "conference-poster"),
      w("Second paper of the scholar", "journal-article", "10.1/two"),
    ];
    const r = filterPublicationWorks(works);
    expect(r.dropped).toBe(2);
    expect(r.collapsed).toBe(1);
    expect(r.kept.map((k) => k.doi)).toEqual(["10.1/one", "10.1/two"]);
  });
});
