/**
 * Compound-form retry — a query that spells a parent by an ENTRY TERM (`covid`) must
 * reach the compound descriptor MeSH names by the parent's own name (`COVID-19
 * Vaccines`), not stop at the window fallback's other word (`vaccines` → Vaccines).
 * Measured on staging 2026-09-15: `covid vaccines` admitted 349 under Vaccines+COVID-19
 * while COVID-19 Vaccines alone admits 1,496; `covid vaccine` resolved NOTHING.
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

const row = (descriptorUi: string, name: string, entryTerms: string[], tree: string) => ({
  descriptorUi,
  name,
  entryTerms,
  scopeNote: null,
  dateRevised: null,
  treeNumbers: [tree],
});
// Real deployed forms (local map, 2026-09-15). Bare `covid` is NOT an NLM entry term of
// COVID-19 — it reaches the map only as the #1258 curated alias, which is how the
// window resolves on staging too.
const COVID19 = row("D000086382", "COVID-19", ["COVID 19", "COVID19", "COVID-19 Pandemic"], "C01.748.610.763.500");
const VACCINES = row("D014612", "Vaccines", ["Vaccine"], "D20.215.894");
const COVID19_VACCINES = row(
  "D000086663",
  "COVID-19 Vaccines",
  ["COVID 19 Vaccines", "COVID-19 Vaccine", "SARS-CoV-2 Vaccine"],
  "D20.215.894.899.085",
);
const COVID19_TESTING = row(
  "D000086742",
  "COVID-19 Testing",
  ["COVID 19 Testing", "COVID-19 Testings", "SARS-CoV-2 Testing"],
  "E01.370.225.312",
);
const IMMUNOTHERAPY = row("D007167", "Immunotherapy", [], "E02.095.465");
const NEOPLASMS = row("D009369", "Neoplasms", ["Cancer"], "C04");
const ALL = [COVID19, VACCINES, COVID19_VACCINES, COVID19_TESTING, IMMUNOTHERAPY, NEOPLASMS];

beforeEach(() => {
  _resetMeshMapForTests();
  mockEtlRunFindFirst.mockResolvedValue(null);
  mockMeshAnchorFindMany.mockResolvedValue([]);
  mockMeshAliasFindMany.mockResolvedValue([{ alias: "COVID", descriptorUi: "D000086382" }]);
  mockMeshFindMany.mockResolvedValue(ALL);
  process.env.SEARCH_MESH_RESOLUTION_FALLBACK = "on";
  process.env.SEARCH_MESH_SECONDARY_CONCEPT = "on";
  process.env.SEARCH_MESH_QUERY_NORMALIZATION = "on";
});
afterEach(() => {
  delete process.env.SEARCH_MESH_RESOLUTION_FALLBACK;
  delete process.env.SEARCH_MESH_SECONDARY_CONCEPT;
  delete process.env.SEARCH_MESH_QUERY_NORMALIZATION;
});

describe("resolveMeshDescriptor — compound-form retry", () => {
  it("`covid vaccines` → COVID-19 Vaccines (exact), not the Vaccines + COVID-19 pair", async () => {
    const r = await resolveMeshDescriptor("covid vaccines");
    expect(r?.name).toBe("COVID-19 Vaccines");
    expect(r?.confidence).toBe("exact");
    expect(r?.secondaryConcept).toBeUndefined();
  });

  it("`covid vaccine` (singular) → COVID-19 Vaccines via the compound's entry term", async () => {
    const r = await resolveMeshDescriptor("covid vaccine");
    expect(r?.name).toBe("COVID-19 Vaccines");
    expect(r?.confidence).toBe("entry-term");
  });

  it("`covid testing` → COVID-19 Testing (exact); `covid testings` via the singularized compound", async () => {
    expect((await resolveMeshDescriptor("covid testing"))?.confidence).toBe("exact");
    expect((await resolveMeshDescriptor("covid testing"))?.name).toBe("COVID-19 Testing");
    // "COVID-19 testings" IS an NLM entry term, so remove it to force the singularize leg.
    _resetMeshMapForTests();
    mockMeshFindMany.mockResolvedValue([
      ...ALL.filter((r) => r !== COVID19_TESTING),
      { ...COVID19_TESTING, entryTerms: ["COVID 19 Testing"] },
    ]);
    expect((await resolveMeshDescriptor("covid testings"))?.name).toBe("COVID-19 Testing");
  });

  it("no compound form exists → the window fallback + pair are untouched", async () => {
    const r = await resolveMeshDescriptor("cancer immunotherapy");
    expect(r?.name).toBe("Immunotherapy");
    expect(r?.confidence).toBe("partial");
    expect(r?.secondaryConcept?.name).toBe("Neoplasms");
  });

  it("fallback flag OFF → byte-identical (null)", async () => {
    delete process.env.SEARCH_MESH_RESOLUTION_FALLBACK;
    expect(await resolveMeshDescriptor("covid vaccines")).toBeNull();
  });
});
