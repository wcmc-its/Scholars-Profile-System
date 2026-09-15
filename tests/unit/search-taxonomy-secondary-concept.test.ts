/**
 * Two-concept resolution (`SEARCH_MESH_SECONDARY_CONCEPT`) — the residual of a
 * `partial` window resolves on its own and rides along as `secondaryConcept`.
 *
 * Measured need (prod `search_query`, 90 d to 2026-09-14): 32 of 68 distinct partial
 * resolutions carried a residual that resolves cleanly, and on every one the second
 * concept was inert. These pin the four behaviours that matter: flag OFF is
 * byte-identical; a resolving residual is attached; a filler residual (`biology`) is
 * refused; nothing is attached when the primary already covered the whole query.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockMeshFindMany, mockEtlRunFindFirst, mockMeshAnchorFindMany, mockMeshAliasFindMany } =
  vi.hoisted(() => ({
    mockMeshFindMany: vi.fn(),
    mockEtlRunFindFirst: vi.fn(),
    mockMeshAnchorFindMany: vi.fn(),
    mockMeshAliasFindMany: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    topic: { findMany: vi.fn().mockResolvedValue([]) },
    subtopic: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) },
    publicationTopic: { groupBy: vi.fn().mockResolvedValue([]) },
    meshDescriptor: { findMany: mockMeshFindMany },
    etlRun: { findFirst: mockEtlRunFindFirst },
    meshCuratedTopicAnchor: { findMany: mockMeshAnchorFindMany },
    meshCuratedAlias: { findMany: mockMeshAliasFindMany },
  },
}));

import { _resetMeshMapForTests, resolveMeshDescriptor } from "@/lib/api/search-taxonomy";

const row = (descriptorUi: string, name: string, entryTerms: string[] = [], tree = "C04") => ({
  descriptorUi,
  name,
  entryTerms,
  scopeNote: null,
  dateRevised: null,
  treeNumbers: [tree],
});
const IMMUNOTHERAPY = row("D007167", "Immunotherapy", [], "E02.095.465");
const NEOPLASMS = row("D009369", "Neoplasms", ["Cancer"], "C04");
const STEM_CELLS = row("D013234", "Stem Cells", ["Stem Cell"], "A11.872");
const BIOLOGY = row("D001695", "Biology", [], "H01.158");
const OBESITY = row("D009765", "Obesity", [], "C18.654.726.500");
// #1346 fixtures — real deployed entry terms (tests/unit/search-taxonomy.test.ts).
const AUTOMOBILES = row("D001334", "Automobiles", ["Car"], "J01.897.280.500.100");
const LYMPHOMA = row("D008223", "Lymphoma", [], "C04.557.386");
const BLOOD = row("D001769", "Blood", [], "A12.207.152");
const LEUKEMIA = row("D007938", "Leukemia", [], "C04.557.337");
const LUNG_NEOPLASMS = row("D008175", "Lung Neoplasms", ["Lung Cancer"], "C04.588.894.797.520");
const NEOPLASMS_C04 = { ...row("D009369", "Neoplasms", ["Cancer", "Tumors"], "C04") };

beforeEach(() => {
  _resetMeshMapForTests();
  mockEtlRunFindFirst.mockResolvedValue(null);
  mockMeshAnchorFindMany.mockResolvedValue([]);
  mockMeshAliasFindMany.mockResolvedValue([]);
  process.env.SEARCH_MESH_RESOLUTION_FALLBACK = "on";
  process.env.SEARCH_MESH_SECONDARY_CONCEPT = "on";
});
afterEach(() => {
  delete process.env.SEARCH_MESH_RESOLUTION_FALLBACK;
  delete process.env.SEARCH_MESH_SECONDARY_CONCEPT;
});

describe("resolveMeshDescriptor — secondaryConcept (SEARCH_MESH_SECONDARY_CONCEPT)", () => {
  it("flag OFF: a partial resolution carries no secondaryConcept (byte-identical)", async () => {
    delete process.env.SEARCH_MESH_SECONDARY_CONCEPT;
    mockMeshFindMany.mockResolvedValue([IMMUNOTHERAPY, NEOPLASMS]);
    const r = await resolveMeshDescriptor("cancer immunotherapy");
    expect(r?.name).toBe("Immunotherapy");
    expect(r?.confidence).toBe("partial");
    expect(r?.secondaryConcept).toBeUndefined();
  });

  it("flag ON: the residual resolves through the verbatim path (an ENTRY TERM is enough)", async () => {
    mockMeshFindMany.mockResolvedValue([IMMUNOTHERAPY, NEOPLASMS]);
    const r = await resolveMeshDescriptor("cancer immunotherapy");
    // Primary is the window (exact NAME, 1-token rule); residual "cancer" is only an
    // entry term of Neoplasms — the window fallback would refuse it, the residual path
    // must not, because reorder-only is the safety net here.
    expect(r?.name).toBe("Immunotherapy");
    expect(r?.secondaryConcept).toMatchObject({
      descriptorUi: "D009369",
      name: "Neoplasms",
      matchedForm: "Cancer",
      confidence: "entry-term",
    });
    expect(r?.secondaryConcept?.descendantUis[0]).toBe("D009369");
  });

  it("flag ON: conjunction delimiters are stripped from the residual", async () => {
    mockMeshFindMany.mockResolvedValue([OBESITY, NEOPLASMS]);
    const r = await resolveMeshDescriptor("cancer and obesity");
    expect(r?.name).toBe("Obesity");
    expect(r?.secondaryConcept?.name).toBe("Neoplasms");
  });

  it("flag ON: a deprioritized filler residual is refused (`stem cell biology` → no Biology)", async () => {
    mockMeshFindMany.mockResolvedValue([STEM_CELLS, BIOLOGY]);
    const r = await resolveMeshDescriptor("stem cell biology");
    expect(r?.name).toBe("Stem Cells");
    expect(r?.secondaryConcept).toBeUndefined();
  });

  it("flag ON: a residual that resolves nothing leaves secondaryConcept unset", async () => {
    mockMeshFindMany.mockResolvedValue([IMMUNOTHERAPY]);
    const r = await resolveMeshDescriptor("glioblastoma immunotherapy");
    expect(r?.name).toBe("Immunotherapy");
    expect(r?.secondaryConcept).toBeUndefined();
  });

  it("flag ON: the #1346 acronym guard applies to the residual (`lymphoma CAR` ≠ Automobiles)", async () => {
    process.env.SEARCH_ACRONYM_SENSE_GUARD = "on";
    try {
      mockMeshFindMany.mockResolvedValue([LYMPHOMA, AUTOMOBILES]);
      const r = await resolveMeshDescriptor("lymphoma CAR");
      expect(r?.name).toBe("Lymphoma");
      expect(r?.secondaryConcept).toBeUndefined();
    } finally {
      delete process.env.SEARCH_ACRONYM_SENSE_GUARD;
    }
  });

  it("flag ON: a one-word residual on the generic list is refused (`leukemia blood` ≠ Blood)", async () => {
    mockMeshFindMany.mockResolvedValue([LEUKEMIA, BLOOD]);
    const r = await resolveMeshDescriptor("leukemia blood");
    expect(r?.name).toBe("Leukemia");
    expect(r?.secondaryConcept).toBeUndefined();
  });

  it("flag ON: an ancestor of the primary is not a second concept (`lung cancer tumors` ≠ Neoplasms)", async () => {
    mockMeshFindMany.mockResolvedValue([LUNG_NEOPLASMS, NEOPLASMS_C04]);
    const r = await resolveMeshDescriptor("lung cancer tumors");
    expect(r?.name).toBe("Lung Neoplasms");
    expect(r?.secondaryConcept).toBeUndefined();
  });

  it("flag ON: deprioritized filler is stripped from the residual before resolving", async () => {
    mockMeshFindMany.mockResolvedValue([IMMUNOTHERAPY, NEOPLASMS]);
    const r = await resolveMeshDescriptor("cancer immunotherapy research");
    expect(r?.name).toBe("Immunotherapy");
    expect(r?.secondaryConcept?.name).toBe("Neoplasms");
  });

  it("flag ON: a verbatim (non-partial) resolution never gets a secondary — nothing is left over", async () => {
    mockMeshFindMany.mockResolvedValue([IMMUNOTHERAPY, NEOPLASMS]);
    const r = await resolveMeshDescriptor("immunotherapy");
    expect(r?.confidence).toBe("exact");
    expect(r?.secondaryConcept).toBeUndefined();
  });
});
