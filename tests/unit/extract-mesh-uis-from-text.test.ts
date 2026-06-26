/**
 * Tests for extractMeshUisFromText (lib/api/search-taxonomy.ts) — the SPS-side
 * MeSH flat-fill extractor that derives opportunity MeSH UIs from title+synopsis.
 * Mocks Prisma per the project's vi.hoisted + vi.mock("@/lib/db") pattern.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockMeshFindMany,
  mockEtlRunFindFirst,
  mockMeshAnchorFindMany,
  mockMeshAliasFindMany,
} = vi.hoisted(() => ({
  mockMeshFindMany: vi.fn(),
  mockEtlRunFindFirst: vi.fn(),
  mockMeshAnchorFindMany: vi.fn(),
  mockMeshAliasFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    meshDescriptor: { findMany: mockMeshFindMany },
    etlRun: { findFirst: mockEtlRunFindFirst },
    meshCuratedTopicAnchor: { findMany: mockMeshAnchorFindMany },
    meshCuratedAlias: { findMany: mockMeshAliasFindMany },
  },
}));

import { _resetMeshMapForTests, extractMeshUisFromText } from "@/lib/api/search-taxonomy";

const D = (descriptorUi: string, name: string, entryTerms: string[], tn: string[]) => ({
  descriptorUi, name, entryTerms, scopeNote: null,
  dateRevised: new Date("2024-01-01"), localPubCoverage: null, treeNumbers: tn,
});

const VOCAB = [
  D("D001943", "Breast Neoplasms", ["Breast Cancer"], ["C04.588.180.260"]),
  D("D003920", "Diabetes Mellitus", ["Diabetes"], ["C18.452.394.750"]),
  D("D000375", "Aging", [], ["G07.345.500"]),
  D("D008545", "Melanoma", [], ["C04.557.665.510"]),
];

beforeEach(() => {
  mockMeshFindMany.mockReset().mockResolvedValue(VOCAB);
  mockEtlRunFindFirst.mockReset().mockResolvedValue({ manifestSha256: "sha-1" });
  mockMeshAnchorFindMany.mockReset().mockResolvedValue([]);
  mockMeshAliasFindMany.mockReset().mockResolvedValue([]);
  _resetMeshMapForTests();
});

describe("extractMeshUisFromText", () => {
  it("extracts multiple distinct descriptors from free text (name + entry-term)", async () => {
    const uis = await extractMeshUisFromText(
      "A program studying breast cancer and diabetes in older adults.",
    );
    expect(uis).toContain("D001943"); // "breast cancer" entry term
    expect(uis).toContain("D003920"); // "diabetes" entry term (single token, len>=5)
  });

  it("greedy longest-match: 'breast neoplasms' resolves once, not breast+neoplasms", async () => {
    const uis = await extractMeshUisFromText("Breast neoplasms research");
    expect(uis).toEqual(["D001943"]);
  });

  it("matches single-token entry terms >=5 chars (recall) but dedups repeats", async () => {
    const uis = await extractMeshUisFromText("Melanoma. Advanced melanoma therapy for melanoma.");
    expect(uis).toEqual(["D008545"]); // matched once despite 3 mentions
  });

  it("returns [] for text with no MeSH and respects the cap", async () => {
    expect(await extractMeshUisFromText("the of and a study program")).toEqual([]);
    expect(await extractMeshUisFromText("")).toEqual([]);
    const capped = await extractMeshUisFromText("breast cancer diabetes aging melanoma", { max: 2 });
    expect(capped).toHaveLength(2);
  });

  it("fails closed to [] when the vocab load throws", async () => {
    mockMeshFindMany.mockRejectedValueOnce(new Error("db down"));
    expect(await extractMeshUisFromText("breast cancer")).toEqual([]);
  });
});
