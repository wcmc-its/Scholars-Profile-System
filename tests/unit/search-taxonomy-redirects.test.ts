/**
 * New-descriptor redirects (`data/search/mesh-redirects.json`) — a query that
 * resolves to a new MeSH descriptor with ~no local tags is swapped to the tree
 * parent that carries the literature (`uveal melanoma` → Uveal Neoplasms), on
 * every route in: exact name, entry term / singular, and the window fallback.
 * How the query was hit (`confidence`, `matchedForm`) is preserved; only the row
 * changes. A `to` missing from the map leaves the original row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import redirects from "@/data/search/mesh-redirects.json";

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

const row = (descriptorUi: string, name: string, entryTerms: string[], trees: string[]) => ({
  descriptorUi,
  name,
  entryTerms,
  scopeNote: null,
  dateRevised: null,
  treeNumbers: trees,
});
// Real UIs — the redirect table is keyed on them.
const UVEAL_NEOPLASMS = row("D014604", "Uveal Neoplasms", [], ["C04.588.364.978", "C11.941.855"]);
const UVEAL_MELANOMA = row("D000098943", "Uveal Melanoma", [], ["C04.557.465.625.650.510.875", "C11.941.855.500"]);
const MELANOMA = row("D008545", "Melanoma", [], ["C04.557.465.625.650.510"]);
const PKI = row("D047428", "Protein Kinase Inhibitors", [], ["D27.505.519.389.755"]);
const TKI = row("D000092004", "Tyrosine Kinase Inhibitors", ["Tyrosine Kinase Inhibitor"], ["D27.505.519.389.755.500"]);
const METASTASIS = row("D009362", "Neoplasm Metastasis", ["Metastasis"], ["C04.697.650"]);

beforeEach(() => {
  _resetMeshMapForTests();
  mockEtlRunFindFirst.mockResolvedValue(null);
  mockMeshAnchorFindMany.mockResolvedValue([]);
  mockMeshAliasFindMany.mockResolvedValue([]);
  process.env.SEARCH_MESH_QUERY_NORMALIZATION = "on";
});
afterEach(() => {
  delete process.env.SEARCH_MESH_QUERY_NORMALIZATION;
  delete process.env.SEARCH_MESH_RESOLUTION_FALLBACK;
  delete process.env.SEARCH_MESH_SECONDARY_CONCEPT;
});

describe("mesh-redirects.json — shape", () => {
  it("well-formed UIs, no self-redirects, no chains", () => {
    const from = new Set(redirects.redirects.map((r) => r.from));
    for (const r of redirects.redirects) {
      expect(r.from).toMatch(/^D\d{6,9}$/);
      expect(r.to).toMatch(/^D\d{6,9}$/);
      expect(r.from).not.toBe(r.to);
      expect(from.has(r.to)).toBe(false);
    }
    expect(from.size).toBe(redirects.redirects.length);
  });
});

describe("resolveMeshDescriptor — new-descriptor redirect", () => {
  it("exact name of the new descriptor resolves to the parent, keeping exact confidence + the hit form", async () => {
    mockMeshFindMany.mockResolvedValue([UVEAL_NEOPLASMS, UVEAL_MELANOMA, MELANOMA]);
    const r = await resolveMeshDescriptor("uveal melanoma");
    expect(r).toMatchObject({
      descriptorUi: "D014604",
      name: "Uveal Neoplasms",
      confidence: "exact",
      matchedForm: "Uveal Melanoma",
    });
    // The parent's subtree still carries the new descriptor's own (few) tags.
    expect(r?.descendantUis).toEqual(expect.arrayContaining(["D014604", "D000098943"]));
  });

  it("the singular / entry-term route is redirected too", async () => {
    mockMeshFindMany.mockResolvedValue([PKI, TKI]);
    const r = await resolveMeshDescriptor("tyrosine kinase inhibitor");
    expect(r?.name).toBe("Protein Kinase Inhibitors");
    expect(r?.confidence).toBe("entry-term");
  });

  it("the window fallback's primary is redirected; the residual still pairs", async () => {
    process.env.SEARCH_MESH_RESOLUTION_FALLBACK = "on";
    process.env.SEARCH_MESH_SECONDARY_CONCEPT = "on";
    mockMeshFindMany.mockResolvedValue([UVEAL_NEOPLASMS, UVEAL_MELANOMA, METASTASIS]);
    const r = await resolveMeshDescriptor("uveal melanoma metastasis");
    expect(r?.name).toBe("Uveal Neoplasms");
    expect(r?.confidence).toBe("partial");
    expect(r?.secondaryConcept?.name).toBe("Neoplasm Metastasis");
  });

  it("a redirect target missing from the map leaves the original row (no throw)", async () => {
    mockMeshFindMany.mockResolvedValue([UVEAL_MELANOMA]);
    const r = await resolveMeshDescriptor("uveal melanoma");
    expect(r?.name).toBe("Uveal Melanoma");
  });

  it("the parent itself is untouched", async () => {
    mockMeshFindMany.mockResolvedValue([UVEAL_NEOPLASMS, UVEAL_MELANOMA]);
    const r = await resolveMeshDescriptor("uveal neoplasms");
    expect(r).toMatchObject({ name: "Uveal Neoplasms", confidence: "exact", matchedForm: "Uveal Neoplasms" });
  });
});
