/**
 * `buildPublicationDoc` — the `translationalStage` keyword
 * (`SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET`). The doc carries the display-ready
 * stage from `displayStage` (lib/translational-stage.ts) and OMITS the field
 * when there is nothing to show, so `_source` consumers and the facet agg
 * never see "NA", a low-confidence stage, or an empty value.
 */
import { describe, expect, it } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import { buildPublicationDoc, type PublicationForIndex } from "@/lib/search-index-docs";

const NO_SUP: PublicationSuppressions = {
  darkPmids: new Set(),
  hiddenAuthorsByPmid: new Map(),
};

function pub(over: Partial<PublicationForIndex>): PublicationForIndex {
  return {
    pmid: "12345",
    title: "A paper",
    journal: "A Journal",
    year: 2024,
    publicationType: "Journal Article",
    citationCount: 0,
    dateAddedToEntrez: null,
    doi: null,
    pmcid: null,
    pubmedUrl: null,
    abstract: null,
    impactScore: null,
    impactJustification: null,
    meshTerms: [] as unknown as PublicationForIndex["meshTerms"],
    authors: [
      {
        pmid: "12345",
        cwid: "aaa1001",
        externalName: null,
        isConfirmed: true,
        isFirst: true,
        isLast: true,
        isPenultimate: false,
        position: 1,
        totalAuthors: 1,
        scholar: {
          cwid: "aaa1001",
          slug: "example-author",
          preferredName: "Example Author",
          deletedAt: null,
          status: "active",
          primaryOrgCode: "WCMC",
        },
      },
    ] as unknown as PublicationForIndex["authors"],
    publicationTopics: [],
    ...over,
  } as PublicationForIndex;
}

function stageOf(over: Partial<PublicationForIndex>) {
  const doc = buildPublicationDoc(pub(over), NO_SUP);
  expect(doc).not.toBeNull();
  return { doc: doc!, has: Object.hasOwn(doc!, "translationalStage") };
}

describe("buildPublicationDoc — translationalStage", () => {
  it("emits the stage at high or medium confidence", () => {
    expect(
      stageOf({ translationalStage: "T2", translationalStageConfidence: "high" }).doc
        .translationalStage,
    ).toBe("T2");
    expect(
      stageOf({ translationalStage: "T3-4", translationalStageConfidence: "medium" }).doc
        .translationalStage,
    ).toBe("T3-4");
  });

  it("emits the stage when confidence was never recorded", () => {
    expect(
      stageOf({ translationalStage: "T0", translationalStageConfidence: null }).doc
        .translationalStage,
    ).toBe("T0");
  });

  it("omits the field at low confidence", () => {
    expect(stageOf({ translationalStage: "T1", translationalStageConfidence: "low" }).has).toBe(
      false,
    );
  });

  it("omits the field for NA", () => {
    expect(stageOf({ translationalStage: "NA", translationalStageConfidence: "high" }).has).toBe(
      false,
    );
  });

  it("omits the field when the publication has no stage, or an unknown one", () => {
    expect(stageOf({ translationalStage: null, translationalStageConfidence: null }).has).toBe(
      false,
    );
    expect(stageOf({}).has).toBe(false);
    expect(stageOf({ translationalStage: "T9", translationalStageConfidence: "high" }).has).toBe(
      false,
    );
  });
});
