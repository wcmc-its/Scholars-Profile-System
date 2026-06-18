/**
 * #824 PR-2 — Method-taxonomy surfacing in the search taxonomy-match callout.
 *
 * Exercises `matchQueryToTaxonomy`'s Method candidates (families + supercategories)
 * from `scholar_family`, gated behind `METHODS_LENS_PAGES` and the #800/#801 overlay
 * gate. Mocks Prisma + the flag per the project's vi.hoisted + vi.mock pattern.
 *
 * Covers the SPEC §9 edge cases: E1 (flag off → no method candidates), E2 (#800
 * suppressed family never a candidate), E3/E4 (#801 sensitive family / all-sensitive
 * supercategory excluded), and the href/count shapes.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockTopicFindMany,
  mockSubtopicFindMany,
  mockSubtopicGroupBy,
  mockPubTopicGroupBy,
  mockMeshFindMany,
  mockEtlRunFindFirst,
  mockMeshAnchorFindMany,
  mockMeshAliasFindMany,
  mockScholarFamilyGroupBy,
  mockScholarFamilyFindMany,
  mockSuppressionOverlayFindMany,
  mockSensitivityOverlayFindMany,
  mockSuppressionFindMany,
  mockPubAuthorFindMany,
  mockMethodPagesEnabled,
  mockSensitiveGateOn,
  mockFamilySynonymsEnabled,
} = vi.hoisted(() => ({
  mockTopicFindMany: vi.fn(),
  mockSubtopicFindMany: vi.fn(),
  mockSubtopicGroupBy: vi.fn(),
  mockPubTopicGroupBy: vi.fn(),
  mockMeshFindMany: vi.fn(),
  mockEtlRunFindFirst: vi.fn(),
  mockMeshAnchorFindMany: vi.fn(),
  mockMeshAliasFindMany: vi.fn(),
  mockScholarFamilyGroupBy: vi.fn(),
  mockScholarFamilyFindMany: vi.fn(),
  mockSuppressionOverlayFindMany: vi.fn(),
  mockSensitivityOverlayFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockPubAuthorFindMany: vi.fn(),
  mockMethodPagesEnabled: vi.fn(),
  mockSensitiveGateOn: vi.fn(),
  mockFamilySynonymsEnabled: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    topic: { findMany: mockTopicFindMany },
    subtopic: { findMany: mockSubtopicFindMany, groupBy: mockSubtopicGroupBy },
    publicationTopic: { groupBy: mockPubTopicGroupBy },
    meshDescriptor: { findMany: mockMeshFindMany },
    etlRun: { findFirst: mockEtlRunFindFirst },
    meshCuratedTopicAnchor: { findMany: mockMeshAnchorFindMany },
    meshCuratedAlias: { findMany: mockMeshAliasFindMany },
    scholarFamily: {
      groupBy: mockScholarFamilyGroupBy,
      findMany: mockScholarFamilyFindMany,
    },
    familySuppressionOverlay: { findMany: mockSuppressionOverlayFindMany },
    familySensitivityOverlay: { findMany: mockSensitivityOverlayFindMany },
    suppression: { findMany: mockSuppressionFindMany },
    publicationAuthor: { findMany: mockPubAuthorFindMany },
  },
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsFamilyDefinitionsOn: () => false,
  isMethodPagesEnabled: () => mockMethodPagesEnabled(),
  isMethodsLensSensitiveGateOn: () => mockSensitiveGateOn(),
  isMethodsLensEnabled: () => true,
  isMethodFamilySynonymsEnabled: () => mockFamilySynonymsEnabled(),
}));

import { matchQueryToTaxonomy } from "@/lib/api/search-taxonomy";

beforeEach(() => {
  mockTopicFindMany.mockReset().mockResolvedValue([]);
  mockSubtopicFindMany.mockReset().mockResolvedValue([]);
  mockSubtopicGroupBy.mockReset().mockResolvedValue([]);
  mockPubTopicGroupBy.mockReset().mockResolvedValue([]);
  mockMeshFindMany.mockReset().mockResolvedValue([]);
  mockEtlRunFindFirst.mockReset().mockResolvedValue({ manifestSha256: "sha-1" });
  mockMeshAnchorFindMany.mockReset().mockResolvedValue([]);
  mockMeshAliasFindMany.mockReset().mockResolvedValue([]);
  mockScholarFamilyGroupBy.mockReset().mockResolvedValue([]);
  mockScholarFamilyFindMany.mockReset().mockResolvedValue([]);
  mockSuppressionOverlayFindMany.mockReset().mockResolvedValue([]);
  mockSensitivityOverlayFindMany.mockReset().mockResolvedValue([]);
  mockSuppressionFindMany.mockReset().mockResolvedValue([]);
  mockPubAuthorFindMany.mockReset().mockResolvedValue([]);
  mockMethodPagesEnabled.mockReset().mockReturnValue(true);
  mockSensitiveGateOn.mockReset().mockReturnValue(false);
  mockFamilySynonymsEnabled.mockReset().mockReturnValue(false);
});

/** Helper: stub the distinct (supercategory, familyLabel) groupBy. */
function familyGroups(
  rows: Array<{ supercategory: string; familyLabel: string; familyId: string }>,
) {
  mockScholarFamilyGroupBy.mockResolvedValue(
    rows.map((r) => ({
      supercategory: r.supercategory,
      familyLabel: r.familyLabel,
      _min: { familyId: r.familyId },
    })),
  );
}

/** Helper: stub the per-family count findMany (scholar rows with pmids). */
function familyRows(rows: Array<{ cwid: string; familyLabel: string; pmids: string[] }>) {
  mockScholarFamilyFindMany.mockResolvedValue(
    rows.map((r) => ({ cwid: r.cwid, familyLabel: r.familyLabel, pmids: r.pmids })),
  );
}

describe("matchQueryToTaxonomy — Method taxonomy candidates (#824)", () => {
  it("E1: METHODS_LENS_PAGES off → no method candidates, no scholar_family read", async () => {
    mockMethodPagesEnabled.mockReturnValue(false);
    familyGroups([
      { supercategory: "imaging_image_analysis", familyLabel: "Flow Cytometry", familyId: "fam_0001" },
    ]);

    const r = await matchQueryToTaxonomy("flow cytometry");
    expect(r.state).toBe("none");
    expect(mockScholarFamilyGroupBy).not.toHaveBeenCalled();
  });

  it("surfaces a matched method family as a methodMatch with the /methods href + counts", async () => {
    familyGroups([
      { supercategory: "imaging_image_analysis", familyLabel: "Flow Cytometry", familyId: "fam_0001" },
    ]);
    familyRows([
      { cwid: "a1", familyLabel: "Flow Cytometry", pmids: ["111", "222"] },
      { cwid: "a2", familyLabel: "Flow Cytometry", pmids: ["222", "333"] },
    ]);

    const r = await matchQueryToTaxonomy("flow cytometry");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    const fam = r.methodMatches.find((m) => m.entityType === "methodFamily");
    expect(fam).toBeTruthy();
    expect(fam!.name).toBe("Flow Cytometry");
    expect(fam!.href).toBe("/methods/imaging-image-analysis/flow-cytometry-fam_0001");
    // 2 distinct scholars, 3 distinct (deduped) pmids, no dark suppressions.
    expect(fam!.scholarCount).toBe(2);
    expect(fam!.publicationCount).toBe(3);
  });

  it("E2: a #800-suppressed family is NEVER a candidate", async () => {
    familyGroups([
      { supercategory: "genomics_sequencing", familyLabel: "Secret Assay", familyId: "fam_0002" },
    ]);
    mockSuppressionOverlayFindMany.mockResolvedValue([
      { supercategory: "genomics_sequencing", familyLabel: "Secret Assay" },
    ]);

    const r = await matchQueryToTaxonomy("secret assay");
    // Suppressed family is the only candidate → it drops → no match at all.
    expect(r.state).toBe("none");
  });

  it("E3: a #801-sensitive family is excluded when the sensitivity gate is on", async () => {
    mockSensitiveGateOn.mockReturnValue(true);
    familyGroups([
      { supercategory: "genomics_sequencing", familyLabel: "Sensitive Method", familyId: "fam_0003" },
    ]);
    mockSensitivityOverlayFindMany.mockResolvedValue([
      { supercategory: "genomics_sequencing", familyLabel: "Sensitive Method" },
    ]);

    const r = await matchQueryToTaxonomy("sensitive method");
    expect(r.state).toBe("none");
  });

  it("E5: a sensitive family IS public when the sensitivity gate is off", async () => {
    mockSensitiveGateOn.mockReturnValue(false);
    familyGroups([
      { supercategory: "genomics_sequencing", familyLabel: "Sensitive Method", familyId: "fam_0003" },
    ]);
    // Overlay row exists but the gate is off → loadFamilyOverlayGate never queries it.
    mockSensitivityOverlayFindMany.mockResolvedValue([
      { supercategory: "genomics_sequencing", familyLabel: "Sensitive Method" },
    ]);
    familyRows([{ cwid: "a1", familyLabel: "Sensitive Method", pmids: ["1"] }]);

    const r = await matchQueryToTaxonomy("sensitive method");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.methodMatches.some((m) => m.name === "Sensitive Method")).toBe(true);
    // Gate-off → the sensitivity overlay table is never read.
    expect(mockSensitivityOverlayFindMany).not.toHaveBeenCalled();
  });

  it("surfaces a supercategory candidate when its label matches, linking to /methods/[sc]", async () => {
    familyGroups([
      { supercategory: "genomics_sequencing", familyLabel: "RNA-seq", familyId: "fam_0010" },
    ]);
    familyRows([{ cwid: "a1", familyLabel: "RNA-seq", pmids: ["1", "2"] }]);

    // Query matches the supercategory label "Genomics & Sequencing".
    const r = await matchQueryToTaxonomy("genomics sequencing");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    const sc = r.methodMatches.find((m) => m.entityType === "supercategory");
    expect(sc).toBeTruthy();
    expect(sc!.name).toBe("Genomics & Sequencing");
    expect(sc!.href).toBe("/methods/genomics-sequencing");
    expect(sc!.scholarCount).toBe(1);
  });

  it("E4: a supercategory whose only family is suppressed is NOT a candidate", async () => {
    familyGroups([
      { supercategory: "genomics_sequencing", familyLabel: "Only Family", familyId: "fam_0011" },
    ]);
    mockSuppressionOverlayFindMany.mockResolvedValue([
      { supercategory: "genomics_sequencing", familyLabel: "Only Family" },
    ]);

    // Even though the query matches the supercategory label, no visible family →
    // the supercategory never becomes a candidate.
    const r = await matchQueryToTaxonomy("genomics sequencing");
    expect(r.state).toBe("none");
  });

  it("supercategory rollup counts distinct scholars across its visible families only", async () => {
    familyGroups([
      { supercategory: "genomics_sequencing", familyLabel: "RNA-seq", familyId: "fam_0010" },
      { supercategory: "genomics_sequencing", familyLabel: "WGS", familyId: "fam_0020" },
      { supercategory: "genomics_sequencing", familyLabel: "Hidden", familyId: "fam_0030" },
    ]);
    mockSuppressionOverlayFindMany.mockResolvedValue([
      { supercategory: "genomics_sequencing", familyLabel: "Hidden" },
    ]);
    // The supercategory rollup findMany returns ALL active rows in the supercat;
    // the loader filters out the suppressed "Hidden" family before counting.
    familyRows([
      { cwid: "a1", familyLabel: "RNA-seq", pmids: ["1"] },
      { cwid: "a2", familyLabel: "WGS", pmids: ["2"] },
      { cwid: "a1", familyLabel: "WGS", pmids: ["3"] }, // a1 in two families → counts once
      { cwid: "a9", familyLabel: "Hidden", pmids: ["9"] }, // suppressed → excluded
    ]);

    const r = await matchQueryToTaxonomy("genomics sequencing");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    const sc = r.methodMatches.find((m) => m.entityType === "supercategory");
    expect(sc).toBeTruthy();
    // a1 + a2 distinct (a9's Hidden family is suppressed) → 2.
    expect(sc!.scholarCount).toBe(2);
    // pmids 1,2,3 from visible families (9 excluded) → 3 distinct.
    expect(sc!.publicationCount).toBe(3);
  });

  it("ranks Topic matches ahead of Method matches; methods do not pollute the chip row", async () => {
    mockTopicFindMany.mockResolvedValue([{ id: "genomics", label: "Genomics" }]);
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "c1" }]);
    familyGroups([
      { supercategory: "genomics_sequencing", familyLabel: "Genomics Pipeline", familyId: "fam_0040" },
    ]);
    familyRows([{ cwid: "a1", familyLabel: "Genomics Pipeline", pmids: ["1"] }]);

    const r = await matchQueryToTaxonomy("genomics");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    // Topic leads as primary; the chip-row `areas` carries only the topic.
    expect(r.primary.entityType).toBe("parentTopic");
    expect(r.areas.every((a) => a.entityType === "parentTopic")).toBe(true);
    // The method surfaces only in methodMatches.
    expect(r.methodMatches.some((m) => m.entityType === "methodFamily")).toBe(true);
  });
});

describe("matchQueryToTaxonomy — method-family synonyms (METHODS_LENS_FAMILY_SYNONYMS)", () => {
  // The real curated map (lib/methods/family-synonyms.ts) is exercised against a
  // family whose (supercategory, label) carries synonyms there.
  const seahorseFamily = {
    supercategory: "functional_metabolic_cellular_assays",
    familyLabel: "extracellular flux respirometry",
    familyId: "fam_0050",
  };

  it("flag OFF: a synonym query does NOT match (byte-identical baseline)", async () => {
    mockFamilySynonymsEnabled.mockReturnValue(false);
    familyGroups([seahorseFamily]);
    familyRows([{ cwid: "a1", familyLabel: "extracellular flux respirometry", pmids: ["1"] }]);

    // "Seahorse" is not a substring of the canonical label → no match when off.
    const r = await matchQueryToTaxonomy("Seahorse metabolic flux");
    expect(r.state).toBe("none");
  });

  it("flag ON: a curated synonym reaches the existing family", async () => {
    mockFamilySynonymsEnabled.mockReturnValue(true);
    familyGroups([seahorseFamily]);
    familyRows([{ cwid: "a1", familyLabel: "extracellular flux respirometry", pmids: ["1", "2"] }]);

    const r = await matchQueryToTaxonomy("Seahorse metabolic flux");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    const fam = r.methodMatches.find((m) => m.entityType === "methodFamily");
    expect(fam?.name).toBe("extracellular flux respirometry");
    expect(fam?.href).toBe(
      "/methods/functional-metabolic-cellular-assays/extracellular-flux-respirometry-fam_0050",
    );
  });

  it("flag ON: window-exact — acronym 'ADC' matches its family but a substring inside a token does not", async () => {
    mockFamilySynonymsEnabled.mockReturnValue(true);
    const adcFamily = {
      supercategory: "therapeutics_interventions",
      familyLabel: "antibody drug conjugate therapeutics",
      familyId: "fam_0060",
    };
    familyGroups([adcFamily]);
    familyRows([
      { cwid: "a1", familyLabel: "antibody drug conjugate therapeutics", pmids: ["1"] },
    ]);

    // "ADC" is a whole-word window → matches via synonym.
    const hit = await matchQueryToTaxonomy("ADC");
    expect(hit.state).toBe("matches");
    if (hit.state === "matches") {
      expect(
        hit.methodMatches.some((m) => m.name === "antibody drug conjugate therapeutics"),
      ).toBe(true);
    }

    // "adcock smith" contains the substring "adc" inside the token "adcock", but
    // never the WINDOW "adc" → window-exact matching rejects it (no false positive).
    const miss = await matchQueryToTaxonomy("adcock smith");
    expect(miss.state).toBe("none");
  });

  it("flag ON: canonical substring matching still works (no regression)", async () => {
    mockFamilySynonymsEnabled.mockReturnValue(true);
    familyGroups([seahorseFamily]);
    familyRows([{ cwid: "a1", familyLabel: "extracellular flux respirometry", pmids: ["1"] }]);

    // The canonical label is still matched as before, synonyms or not.
    const r = await matchQueryToTaxonomy("extracellular flux");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.methodMatches.some((m) => m.name === "extracellular flux respirometry")).toBe(true);
  });

  it("flag ON: a multi-word / hyphenated synonym matches via the token window", async () => {
    mockFamilySynonymsEnabled.mockReturnValue(true);
    const scRnaFamily = {
      supercategory: "genomics_sequencing",
      familyLabel: "single cell rna sequencing",
      familyId: "fam_0070",
    };
    familyGroups([scRnaFamily]);
    familyRows([{ cwid: "a1", familyLabel: "single cell rna sequencing", pmids: ["1"] }]);

    // "single-cell RNA-seq" is a curated multi-token synonym (normalizes to a
    // single joined key spanning several query tokens) — the window matcher must
    // find it, not just single-token acronyms like "ADC".
    const r = await matchQueryToTaxonomy("single-cell RNA-seq");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.methodMatches.some((m) => m.name === "single cell rna sequencing")).toBe(true);
  });

  it("flag ON: a synonym substring inside a longer token does NOT over-match (selfish ≠ FISH)", async () => {
    mockFamilySynonymsEnabled.mockReturnValue(true);
    const fishFamily = {
      supercategory: "microscopy_histology",
      familyLabel: "in situ hybridization",
      familyId: "fam_0080",
    };
    familyGroups([fishFamily]);
    familyRows([{ cwid: "a1", familyLabel: "in situ hybridization", pmids: ["1"] }]);

    // "FISH" is a curated synonym (normalizes to "fish"); "selfish" CONTAINS
    // "fish" as a substring but never as a whole-word window → no false match.
    const r = await matchQueryToTaxonomy("selfish behavior");
    expect(r.state).toBe("none");
  });

  it("flag ON: dropped polysemous acronyms (OCT/SEM/PALM) no longer reach a family; full forms still do (#1094)", async () => {
    mockFamilySynonymsEnabled.mockReturnValue(true);
    const families = [
      { supercategory: "imaging_image_analysis", familyLabel: "optical coherence tomography", familyId: "fam_oct" },
      { supercategory: "microscopy_histology", familyLabel: "electron microscopy", familyId: "fam_em" },
      { supercategory: "microscopy_histology", familyLabel: "super resolution microscopy", familyId: "fam_sr" },
    ];
    familyGroups(families);
    familyRows(families.map((f) => ({ cwid: "a1", familyLabel: f.familyLabel, pmids: ["1"] })));

    // The bare acronyms were removed (date / stats / anatomy collisions) → none
    // surfaces a method family.
    for (const q of ["OCT", "SEM", "PALM"]) {
      const r = await matchQueryToTaxonomy(q);
      expect(r.state, `"${q}" should not match after the acronym drop`).toBe("none");
    }

    // The retained full-form synonym still reaches its family.
    const oc = await matchQueryToTaxonomy("optical coherence");
    expect(oc.state).toBe("matches");
    if (oc.state !== "matches") return;
    expect(oc.methodMatches.some((m) => m.name === "optical coherence tomography")).toBe(true);
  });
});
