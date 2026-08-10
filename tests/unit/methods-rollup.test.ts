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

/** A member row as getFamiliesForSupercategory now loads them (#2292). */
type MemberRow = {
  familyLabel: string;
  familyId: string;
  cwid: string;
  pmidCount: number;
  scholar: { roleCategory: string | null };
};

/** Terse member-row builder — the fixtures below are dense enough to warrant it. */
const member = (
  familyLabel: string,
  familyId: string,
  cwid: string,
  pmidCount: number,
  roleCategory: string | null,
): MemberRow => ({ familyLabel, familyId, cwid, pmidCount, scholar: { roleCategory } });

/** Dispatch the three distinct scholarFamily.findMany call-sites by their `select`. */
function wireScholarFamilyFindMany(opts: {
  pmidRows: Array<{ familyLabel: string; pmids: string[] }>;
  exemplarRows: Array<{ familyLabel: string; exemplarTools: string[] }>;
  memberRows?: MemberRow[];
}) {
  mockScholarFamilyFindMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
    if (args.select?.pmids) return Promise.resolve(opts.pmidRows);
    if (args.select?.exemplarTools) return Promise.resolve(opts.exemplarRows);
    // #2292 — the member fetch that replaced the uncarved groupBy.
    if (args.select?.cwid) return Promise.resolve(opts.memberRows ?? []);
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
    // #2292 — getFamiliesForSupercategory aggregates member ROWS now (a groupBy
    // cannot fail closed). 3 families, one ("Secret") will be #800-suppressed.
    // Deep learning: 3 cwids / pmidSum 10; MRI: 2 / 6; Secret: 1 / 2.
    wireScholarFamilyFindMany({
      memberRows: [
        member("Deep learning", "fam_0001", "aaa1001", 4, "full_time_faculty"),
        member("Deep learning", "fam_0001", "aaa1002", 3, "full_time_faculty"),
        member("Deep learning", "fam_0001", "aaa1003", 3, null),
        member("MRI", "fam_0002", "bbb2001", 3, "full_time_faculty"),
        member("MRI", "fam_0002", "bbb2002", 3, "postdoc"),
        member("Secret", "fam_0003", "ccc3001", 2, "full_time_faculty"),
      ],
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
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
  });
});

describe("#2292 — the family card's scholarCount runs both halves of the carve", () => {
  beforeEach(() => {
    mockSuppressionOverlayFindMany.mockResolvedValue([]);
    mockPublicationFindMany.mockResolvedValue([]);
  });

  it("filters at the QUERY layer on deletedAt/status AND the role denylist", async () => {
    wireScholarFamilyFindMany({ pmidRows: [], exemplarRows: [], memberRows: [] });
    await getSupercategoryRollup(SC);

    const memberCall = mockScholarFamilyFindMany.mock.calls.find(
      (c) => (c[0] as { select?: Record<string, unknown> }).select?.cwid,
    );
    expect(memberCall, "getFamiliesForSupercategory must load member rows").toBeDefined();
    const where = (memberCall![0] as { where: { scholar?: Record<string, unknown> } }).where;
    // The uncarved groupBy had no scholar join at all — this is the #2292 defect.
    expect(where.scholar).toBeDefined();
    expect(where.scholar).toMatchObject({ deletedAt: null, status: "active" });
    expect(where.scholar!.OR).toEqual(
      expect.arrayContaining([expect.objectContaining({ roleCategory: null })]),
    );
    // And it must select the column the fail-closed half reads.
    expect((memberCall![0] as { select: Record<string, unknown> }).select.scholar).toEqual({
      select: { roleCategory: true },
    });
  });

  it("fails CLOSED on an out-of-band suffix the denylist cannot name", async () => {
    // `doctoral_student_dvm` is not in HIDDEN_ROLE_CATEGORIES, so publicRoleWhere()
    // admits it — only isPubliclyDisplayed's prefix match rejects it. If the
    // post-filter is removed this family reads 2 scholars instead of 1.
    wireScholarFamilyFindMany({
      pmidRows: [],
      exemplarRows: [],
      memberRows: [
        member("MRI", "fam_0002", "bbb2001", 3, "full_time_faculty"),
        member("MRI", "fam_0002", "zzz9999", 7, "doctoral_student_dvm"),
      ],
    });

    const { families } = await getSupercategoryRollup(SC);
    const mri = families.find((f) => f.familyLabel === "MRI")!;
    expect(mri.scholarCount).toBe(1);
    // The aggregates all describe the same carved population, so the hidden
    // row's pmidCount must not inflate the sort tiebreak either.
    expect(mri.pmidCountSum).toBe(3);
  });

  it("counts a scholar once per family and admits a null role", async () => {
    wireScholarFamilyFindMany({
      pmidRows: [],
      exemplarRows: [],
      memberRows: [
        member("MRI", "fam_0002", "bbb2001", 2, null),
        member("MRI", "fam_0009", "bbb2001", 2, null),
      ],
    });

    const { families } = await getSupercategoryRollup(SC);
    const mri = families.find((f) => f.familyLabel === "MRI")!;
    expect(mri.scholarCount).toBe(1); // distinct cwids, not rows
    expect(mri.familyId).toBe("fam_0009"); // lexicographic max, as MySQL MAX() was
  });
});

describe("getSupercategoryHubEntries", () => {
  it("carries each supercategory's visible families (id + label + scholar count) for the hub deep-links", async () => {
    mockSuppressionOverlayFindMany.mockResolvedValue([]);
    // The remaining groupBy enumerates the supercategories; the per-family
    // aggregation is a carved member fetch since #2292.
    mockScholarFamilyGroupBy.mockResolvedValue([{ supercategory: SC }]);
    wireScholarFamilyFindMany({
      pmidRows: [],
      exemplarRows: [],
      memberRows: [
        member("Deep learning", "fam_0001", "aaa1001", 4, "full_time_faculty"),
        member("Deep learning", "fam_0001", "aaa1002", 3, "full_time_faculty"),
        member("Deep learning", "fam_0001", "aaa1003", 3, null),
        member("MRI", "fam_0002", "bbb2001", 3, "full_time_faculty"),
        member("MRI", "fam_0002", "bbb2002", 3, "postdoc"),
      ],
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
