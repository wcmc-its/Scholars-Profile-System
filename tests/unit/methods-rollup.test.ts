/**
 * UX feedback A1/A2/A3 + B5 — the supercategory rollup and hub family list.
 *
 * Exercises `getSupercategoryRollup` (distinct dark-filtered paper counts, the
 * deduped exemplar union capped at 3, and the "All work" representative feed over
 * the supercategory-wide pmid union) and `getSupercategoryHubEntries` (the family
 * list each hub entry now carries). Mocks Prisma + the lens flags + the
 * suppression/dark + author helpers per the project's vi.hoisted pattern.
 *
 * Asserts the gating invariant the overlay exists to guarantee: a #800-suppressed
 * family contributes neither a roster row nor a single pmid to the union.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockScholarFamilyGroupBy,
  mockScholarFamilyFindMany,
  mockPublicationFindMany,
  mockSuppressionOverlayFindMany,
  mockSensitivityOverlayFindMany,
  mockLoadPublicationSuppressions,
  mockResolveDarkPmids,
  mockFetchWcmAuthorsForPmids,
  mockLensEnabled,
  mockSensitiveGateOn,
} = vi.hoisted(() => ({
  mockScholarFamilyGroupBy: vi.fn(),
  mockScholarFamilyFindMany: vi.fn(),
  mockPublicationFindMany: vi.fn(),
  mockSuppressionOverlayFindMany: vi.fn(),
  mockSensitivityOverlayFindMany: vi.fn(),
  mockLoadPublicationSuppressions: vi.fn(),
  mockResolveDarkPmids: vi.fn(),
  mockFetchWcmAuthorsForPmids: vi.fn(),
  mockLensEnabled: vi.fn(),
  mockSensitiveGateOn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholarFamily: {
      groupBy: mockScholarFamilyGroupBy,
      findMany: mockScholarFamilyFindMany,
    },
    publication: { findMany: mockPublicationFindMany },
    familySuppressionOverlay: { findMany: mockSuppressionOverlayFindMany },
    familySensitivityOverlay: { findMany: mockSensitivityOverlayFindMany },
  },
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsFamilyDefinitionsOn: () => false,
  isMethodsLensEnabled: () => mockLensEnabled(),
  isMethodsLensSensitiveGateOn: () => mockSensitiveGateOn(),
  isMethodPagesEnabled: () => true,
}));

vi.mock("@/lib/api/manual-layer", () => ({
  loadPublicationSuppressions: (...a: unknown[]) => mockLoadPublicationSuppressions(...a),
  resolveDarkPmids: (...a: unknown[]) => mockResolveDarkPmids(...a),
  loadHiddenAuthorshipCounts: () => Promise.resolve(new Map()),
}));

vi.mock("@/lib/api/topics", () => ({
  fetchWcmAuthorsForPmids: (...a: unknown[]) => mockFetchWcmAuthorsForPmids(...a),
}));

import {
  getSupercategoryRollup,
  getSupercategoryHubEntries,
} from "@/lib/api/methods";

const SC = "imaging_image_analysis";

/** Dispatch the two distinct scholarFamily.findMany call-sites by their `select`. */
function wireScholarFamilyFindMany(opts: {
  pmidRows: Array<{ familyLabel: string; pmids: string[] }>;
  exemplarRows: Array<{ familyLabel: string; exemplarTools: string[] }>;
}) {
  mockScholarFamilyFindMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
    if (args.select?.pmids) return Promise.resolve(opts.pmidRows);
    if (args.select?.exemplarTools) return Promise.resolve(opts.exemplarRows);
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLensEnabled.mockReturnValue(true);
  mockSensitiveGateOn.mockReturnValue(false);
  mockSensitivityOverlayFindMany.mockResolvedValue([]);
  mockLoadPublicationSuppressions.mockResolvedValue({});
  mockResolveDarkPmids.mockResolvedValue(new Set<string>());
  mockFetchWcmAuthorsForPmids.mockResolvedValue(new Map());
});

describe("getSupercategoryRollup", () => {
  beforeEach(() => {
    // groupBy by familyLabel (getFamiliesForSupercategory) — 3 families, one
    // ("Secret") will be #800-suppressed.
    mockScholarFamilyGroupBy.mockResolvedValue([
      { familyLabel: "Deep learning", _count: { cwid: 3 }, _sum: { pmidCount: 10 }, _max: { familyId: "fam_0001" } },
      { familyLabel: "MRI", _count: { cwid: 2 }, _sum: { pmidCount: 6 }, _max: { familyId: "fam_0002" } },
      { familyLabel: "Secret", _count: { cwid: 1 }, _sum: { pmidCount: 2 }, _max: { familyId: "fam_0003" } },
    ]);
    wireScholarFamilyFindMany({
      pmidRows: [
        { familyLabel: "Deep learning", pmids: ["1", "2", "3"] },
        { familyLabel: "Deep learning", pmids: ["2", "3", "4"] }, // overlap → distinct {1,2,3,4}
        { familyLabel: "MRI", pmids: ["5", "6"] },
        { familyLabel: "MRI", pmids: ["6", "7"] }, // distinct {5,6,7}
        { familyLabel: "Secret", pmids: ["8", "9"] }, // suppressed — must not contribute
      ],
      exemplarRows: [
        { familyLabel: "Deep learning", exemplarTools: ["CNN", "U-Net"] },
        { familyLabel: "Deep learning", exemplarTools: ["U-Net", "ResNet", "ViT"] }, // dedupe + cap 3
        { familyLabel: "MRI", exemplarTools: ["T1", "T2"] },
      ],
    });
  });

  it("computes DISTINCT (deduped, dark-filtered) paper counts and the union exemplar set (cap 3)", async () => {
    // pmid "4" is dark — drops from Deep learning's distinct {1,2,3,4} → 3.
    mockResolveDarkPmids.mockResolvedValue(new Set(["4"]));
    mockSuppressionOverlayFindMany.mockResolvedValue([{ supercategory: SC, familyLabel: "Secret" }]);
    mockPublicationFindMany.mockResolvedValue([]);

    const { families } = await getSupercategoryRollup(SC);

    // Secret excluded; sorted by scholarCount desc.
    expect(families.map((f) => f.familyLabel)).toEqual(["Deep learning", "MRI"]);

    const dl = families.find((f) => f.familyLabel === "Deep learning")!;
    expect(dl.pubCount).toBe(3); // {1,2,3} — "4" dark
    expect(dl.exemplarTools).toEqual(["CNN", "U-Net", "ResNet"]); // deduped, capped at 3

    const mri = families.find((f) => f.familyLabel === "MRI")!;
    expect(mri.pubCount).toBe(3); // {5,6,7}
    expect(mri.exemplarTools).toEqual(["T1", "T2"]);
  });

  it("excludes a suppressed family's pmids from the All-work union AND drops dark pmids", async () => {
    mockResolveDarkPmids.mockResolvedValue(new Set(["4"]));
    mockSuppressionOverlayFindMany.mockResolvedValue([{ supercategory: SC, familyLabel: "Secret" }]);
    mockPublicationFindMany.mockResolvedValue([
      {
        pmid: "1", title: "Deep seg", journal: "Nature", year: 2025,
        publicationType: "Journal Article", citationCount: 5, pubmedUrl: null,
        doi: null, pmcid: null, impactScore: null, abstract: null, dateAddedToEntrez: null,
      },
    ]);

    const { allWorkPubs } = await getSupercategoryRollup(SC);

    // The representative query runs over the union; assert its pmid set.
    const where = mockPublicationFindMany.mock.calls[0][0].where;
    const unionPmids: string[] = where.pmid.in;
    expect(new Set(unionPmids)).toEqual(new Set(["1", "2", "3", "5", "6", "7"]));
    expect(unionPmids).not.toContain("4"); // dark
    expect(unionPmids).not.toContain("8"); // suppressed family
    expect(unionPmids).not.toContain("9");

    expect(allWorkPubs).toHaveLength(1);
    expect(allWorkPubs[0].pmid).toBe("1");
  });

  it("returns empty when the master lens is off (no DB reads)", async () => {
    mockLensEnabled.mockReturnValue(false);
    const out = await getSupercategoryRollup(SC);
    expect(out).toEqual({ families: [], allWorkPubs: [] });
    expect(mockScholarFamilyGroupBy).not.toHaveBeenCalled();
  });
});

describe("getSupercategoryHubEntries", () => {
  it("carries each supercategory's visible families (id + label + scholar count) for the hub deep-links", async () => {
    mockSuppressionOverlayFindMany.mockResolvedValue([]);
    // First groupBy: by supercategory. Then by familyLabel per supercategory.
    mockScholarFamilyGroupBy.mockImplementation((args: { by: string[]; where?: { supercategory?: string } }) => {
      if (args.by.includes("supercategory") && !args.by.includes("familyLabel")) {
        return Promise.resolve([{ supercategory: SC }]);
      }
      return Promise.resolve([
        { familyLabel: "Deep learning", _count: { cwid: 3 }, _sum: { pmidCount: 10 }, _max: { familyId: "fam_0001" } },
        { familyLabel: "MRI", _count: { cwid: 2 }, _sum: { pmidCount: 6 }, _max: { familyId: "fam_0002" } },
      ]);
    });

    const entries = await getSupercategoryHubEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.familyCount).toBe(2);
    expect(e.families).toEqual([
      { familyId: "fam_0001", familyLabel: "Deep learning", scholarCount: 3 },
      { familyId: "fam_0002", familyLabel: "MRI", scholarCount: 2 },
    ]);
  });
});
