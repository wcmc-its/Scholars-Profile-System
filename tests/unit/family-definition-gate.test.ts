/**
 * #879 — the cache-safety gate for the generated family definition. This is the
 * single most security-relevant invariant in the change: when
 * METHODS_LENS_FAMILY_DEFINITIONS is OFF, the definition must NOT reach the
 * CloudFront-cached profile payload (profile.ts) or the DefinedTerm JSON-LD / SEO
 * on the family page (methods.ts) — even when the DB row HAS a populated
 * definition. These tests pin BOTH gates against an off-flag leak and against the
 * `Array.map((r, i) => fn(r, i))` index-as-boolean footgun on the profile path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { familySlug, supercategorySlug } from "@/lib/method-url";

const {
  mockGroupBy,
  mockFindFirst,
  mockFindMany,
  mockSuppression,
  mockSensitivity,
  mockLensEnabled,
  mockSensitiveGateOn,
  mockDefinitionsOn,
} = vi.hoisted(() => ({
  mockGroupBy: vi.fn(),
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
  mockSuppression: vi.fn(),
  mockSensitivity: vi.fn(),
  mockLensEnabled: vi.fn(),
  mockSensitiveGateOn: vi.fn(),
  mockDefinitionsOn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholarFamily: { groupBy: mockGroupBy, findFirst: mockFindFirst, findMany: mockFindMany },
    familySuppressionOverlay: { findMany: mockSuppression },
    familySensitivityOverlay: { findMany: mockSensitivity },
  },
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsLensEnabled: () => mockLensEnabled(),
  isMethodsLensSensitiveGateOn: () => mockSensitiveGateOn(),
  isMethodsFamilyDefinitionsOn: () => mockDefinitionsOn(),
  isMethodsLensToolContextOn: () => false,
  isMethodPagesEnabled: () => true,
  isMethodsFamilyRosterFallbackOn: () => false,
}));

// methods.ts pulls these in via topics.ts / manual-layer — stub so the import
// graph resolves without dragging the real DB/helpers into this unit.
vi.mock("@/lib/api/manual-layer", () => ({
  loadPublicationSuppressions: vi.fn(),
  resolveDarkPmids: vi.fn(),
  loadHiddenAuthorshipCounts: () => Promise.resolve(new Map()),
}));
vi.mock("@/lib/api/topics", () => ({ fetchWcmAuthorsForPmids: vi.fn() }));

import { getFamily } from "@/lib/api/methods";
import { loadScholarFamilies } from "@/lib/api/profile";

const SC = "imaging_image_analysis";
const LABEL = "Deep learning";
const FAM_ID = "fam_0001";
const DEF = "Convolutional and transformer networks—including U-Net—for image tasks.";

beforeEach(() => {
  vi.clearAllMocks();
  mockLensEnabled.mockReturnValue(true);
  mockSensitiveGateOn.mockReturnValue(false);
  mockSuppression.mockResolvedValue([]);
  mockSensitivity.mockResolvedValue([]);
  // groupBy is called for both [supercategory] and [familyLabel] (the latter
  // carries _max) — discriminate by the presence of _max.
  mockGroupBy.mockImplementation((args: { _max?: unknown }) =>
    Promise.resolve(
      args?._max
        ? [{ familyLabel: LABEL, _max: { familyId: FAM_ID } }]
        : [{ supercategory: SC }],
    ),
  );
  mockFindFirst.mockResolvedValue({ definition: DEF, definitionSource: "generated" });
  mockFindMany.mockResolvedValue([
    {
      familyId: FAM_ID,
      familyLabel: LABEL,
      supercategory: SC,
      pmidCount: 7,
      exemplarTools: ["U-Net"],
      pmids: ["1", "2", "3", "4", "5", "6", "7"],
      definition: DEF,
      definitionSource: "generated",
    },
  ]);
});

describe("#879 getFamily definition gate (methods.ts — the JSON-LD/SEO path)", () => {
  const seg = () => familySlug(LABEL, FAM_ID);

  it("OFF: returns definition=null AND never reads the column (no SEO/cache leak)", async () => {
    mockDefinitionsOn.mockReturnValue(false);
    const resolved = await getFamily(supercategorySlug(SC), seg());
    expect(resolved).not.toBeNull();
    expect(resolved!.definition).toBeNull();
    expect(resolved!.definitionSource).toBeNull();
    expect(mockFindFirst).not.toHaveBeenCalled(); // the gate skips the read entirely
  });

  it("ON: surfaces the verbatim definition + source", async () => {
    mockDefinitionsOn.mockReturnValue(true);
    const resolved = await getFamily(supercategorySlug(SC), seg());
    expect(resolved!.definition).toBe(DEF); // em-dash preserved verbatim
    expect(resolved!.definitionSource).toBe("generated");
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
  });
});

describe("#879 loadScholarFamilies definition gate (profile.ts — the cached payload)", () => {
  it("OFF: nulls the definition even though the DB row has one (no cache bake-in)", async () => {
    mockDefinitionsOn.mockReturnValue(false);
    const families = await loadScholarFamilies("abc1234");
    expect(families).toHaveLength(1);
    expect(families[0].definition).toBeNull();
    expect(families[0].definitionSource).toBeNull();
  });

  it("ON: passes the definition through to the view", async () => {
    mockDefinitionsOn.mockReturnValue(true);
    const families = await loadScholarFamilies("abc1234");
    expect(families[0].definition).toBe(DEF);
    expect(families[0].definitionSource).toBe("generated");
  });
});
