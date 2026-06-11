/**
 * #879 — getFamilyMeshDefinition unit tests. Asserts the read-path contract:
 * a definition surfaces ONLY for a confidence='curated' anchor whose descriptor
 * still exists with a non-null scope note; everything else (flag off, derived,
 * no anchor, stale descriptor, null scope note) → null, never a throw.
 *
 * Mocks @/lib/db + methods.ts's transitive deps per the project vi.hoisted
 * pattern; the flag is driven via process.env (the real flag fn reads it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAnchorFindFirst, mockDescriptorFindUnique } = vi.hoisted(() => ({
  mockAnchorFindFirst: vi.fn(),
  mockDescriptorFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    meshCuratedFamilyAnchor: { findFirst: mockAnchorFindFirst },
    meshDescriptor: { findUnique: mockDescriptorFindUnique },
  },
}));

// Real flag fns read process.env; the others are stubbed so importing methods.ts
// doesn't drag in their behavior.
vi.mock("@/lib/api/manual-layer", () => ({
  loadPublicationSuppressions: vi.fn(),
  resolveDarkPmids: vi.fn(),
  loadHiddenAuthorshipCounts: () => Promise.resolve(new Map()),
}));
vi.mock("@/lib/api/topics", () => ({
  fetchWcmAuthorsForPmids: vi.fn(),
  fetchAuthorBylineForPmids: vi.fn(),
}));

import { getFamilyMeshDefinition } from "@/lib/api/methods";

const SC = "molecular_biochem_reagents";
const FAM = "Flow cytometry assays";

beforeEach(() => {
  mockAnchorFindFirst.mockReset();
  mockDescriptorFindUnique.mockReset();
  process.env.METHODS_LENS_MESH_DEFINITIONS = "on";
});

afterEach(() => {
  delete process.env.METHODS_LENS_MESH_DEFINITIONS;
});

describe("getFamilyMeshDefinition (#879)", () => {
  it("curated anchor + descriptor with scope note → returns the definition", async () => {
    mockAnchorFindFirst.mockResolvedValue({ descriptorUi: "D005434" });
    mockDescriptorFindUnique.mockResolvedValue({
      descriptorUi: "D005434",
      name: "Flow Cytometry",
      scopeNote: "Technique using an instrument system for making, processing, and displaying…",
    });
    const def = await getFamilyMeshDefinition(SC, FAM);
    expect(def).toEqual({
      descriptorUi: "D005434",
      name: "Flow Cytometry",
      scopeNote: "Technique using an instrument system for making, processing, and displaying…",
    });
  });

  it("only queries confidence='curated' anchors (derived rows are never surfaced)", async () => {
    mockAnchorFindFirst.mockResolvedValue(null);
    await getFamilyMeshDefinition(SC, FAM);
    expect(mockAnchorFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { supercategory: SC, familyLabel: FAM, confidence: "curated" },
        orderBy: { descriptorUi: "asc" },
      }),
    );
  });

  it("no curated anchor → null (no descriptor lookup)", async () => {
    mockAnchorFindFirst.mockResolvedValue(null);
    expect(await getFamilyMeshDefinition(SC, FAM)).toBeNull();
    expect(mockDescriptorFindUnique).not.toHaveBeenCalled();
  });

  it("curated anchor but null scope note → null", async () => {
    mockAnchorFindFirst.mockResolvedValue({ descriptorUi: "D005434" });
    mockDescriptorFindUnique.mockResolvedValue({
      descriptorUi: "D005434",
      name: "Flow Cytometry",
      scopeNote: null,
    });
    expect(await getFamilyMeshDefinition(SC, FAM)).toBeNull();
  });

  it("curated anchor but stale descriptor (no-FK design) → null, no throw", async () => {
    mockAnchorFindFirst.mockResolvedValue({ descriptorUi: "D999999" });
    mockDescriptorFindUnique.mockResolvedValue(null);
    await expect(getFamilyMeshDefinition(SC, FAM)).resolves.toBeNull();
  });

  it("flag off → null and zero DB calls (gate runs first)", async () => {
    process.env.METHODS_LENS_MESH_DEFINITIONS = "off";
    expect(await getFamilyMeshDefinition(SC, FAM)).toBeNull();
    expect(mockAnchorFindFirst).not.toHaveBeenCalled();
    expect(mockDescriptorFindUnique).not.toHaveBeenCalled();
  });
});
