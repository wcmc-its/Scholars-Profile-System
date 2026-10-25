/**
 * `etl/orcid-evidence/work-filter` — which ORCID works are publications (ORCID
 * queue v2 spec, item 3): the dropped types, figure / supplement titles on
 * `other` works, Figshare / Zenodo DOIs unless typed journal-article, and
 * preprint versions collapsed onto the published work. Reused by the Phase 2
 * harvest, so every rule is pinned here. Synthetic titles and DOIs.
 */
import { describe, expect, it } from "vitest";

import {
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
  ])("drops an `other` or untyped work titled %s", (title) => {
    expect(isNonPublicationWork(w(title, "other"))).toBe(true);
    expect(isNonPublicationWork(w(title, null))).toBe(true);
  });

  it("keeps an `other` work with a paper's title", () => {
    expect(isNonPublicationWork(w("Tables and chairs in the clinic", "other"))).toBe(false);
    expect(isNonPublicationWork(w("Outcomes after transplant", "other"))).toBe(false);
  });

  it("drops a Figshare or Zenodo DOI unless typed journal-article", () => {
    expect(isNonPublicationWork(w("Raw counts", "other", "10.6084/m9.figshare.123"))).toBe(true);
    expect(isNonPublicationWork(w("Model weights", null, "10.5281/zenodo.42"))).toBe(true);
    expect(isNonPublicationWork(w("Model weights", "journal-article", "10.5281/zenodo.42"))).toBe(
      false,
    );
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
