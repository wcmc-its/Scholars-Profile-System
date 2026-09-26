/**
 * Phase 3 (TAXONOMY_SCHOLAR_CARDS) — the per-scholar `cwid` filter in the two
 * publication loaders, plus the access-control helpers behind it.
 *
 *   - isPublicScholarCwid: unknown / hidden (#536, incl. an out-of-band
 *     `doctoral_student_*` suffix the denylist cannot express) → false.
 *   - getTopicPublications: a refused cwid returns the empty shape without
 *     running the feed query; an accepted one scopes the page query AND every
 *     COUNT to `pt.cwid`, minus the scholar's per-author hides.
 *   - getFamilyPublications: the feed is the family's gated union intersected
 *     with the scholar's own ScholarFamily.pmids for (cwid, family); a hidden
 *     cwid gets exactly what an unknown one gets.
 *
 * Fake cwids only (public repo).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";

const {
  mockTopicFindUnique,
  mockPublicationTopicFindMany,
  mockPublicationAuthorFindMany,
  mockPublicationFindMany,
  mockPublicationCount,
  mockSuppressionFindMany,
  mockScholarFindFirst,
  mockScholarFamilyFindMany,
  mockSuppressionOverlayFindMany,
  mockSensitivityOverlayFindMany,
  mockTransaction,
  mockQueryRaw,
} = vi.hoisted(() => ({
  mockTopicFindUnique: vi.fn(),
  mockPublicationTopicFindMany: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockPublicationFindMany: vi.fn(),
  mockPublicationCount: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockScholarFindFirst: vi.fn(),
  mockScholarFamilyFindMany: vi.fn(),
  mockSuppressionOverlayFindMany: vi.fn(),
  mockSensitivityOverlayFindMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockQueryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    topic: { findUnique: mockTopicFindUnique },
    publicationTopic: { findMany: mockPublicationTopicFindMany },
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    publication: { findMany: mockPublicationFindMany, count: mockPublicationCount },
    suppression: { findMany: mockSuppressionFindMany },
    scholar: { findFirst: mockScholarFindFirst },
    scholarFamily: { findMany: mockScholarFamilyFindMany },
    familySuppressionOverlay: { findMany: mockSuppressionOverlayFindMany },
    familySensitivityOverlay: { findMany: mockSensitivityOverlayFindMany },
    $queryRaw: mockQueryRaw,
    $transaction: mockTransaction,
  },
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsLensEnabled: () => true,
  isMethodsLensSensitiveGateOn: () => false,
  isMethodsLensToolContextOn: () => false,
  isMethodsFamilyRosterFallbackOn: () => false,
  isMethodsFamilyDefinitionsOn: () => false,
  isMethodsLensEntityLayerOn: () => false,
  isMethodPagesEnabled: () => true,
}));

import { isPublicScholarCwid, loadHiddenAuthorshipPmids } from "@/lib/api/scholar-filter";
import { getTopicPublications } from "@/lib/api/topics";
import { getFamilyPublications } from "@/lib/api/methods";

const TOPIC = { id: "cardio", label: "Cardio", displayThreshold: null };
const count = (n: number) => [{ c: BigInt(n) }];

beforeEach(() => {
  vi.clearAllMocks();
  mockPublicationAuthorFindMany.mockResolvedValue([]);
  mockPublicationFindMany.mockResolvedValue([]);
  mockSuppressionFindMany.mockResolvedValue([]);
  mockSuppressionOverlayFindMany.mockResolvedValue([]);
  mockSensitivityOverlayFindMany.mockResolvedValue([]);
  mockQueryRaw.mockResolvedValue(count(0));
});

describe("isPublicScholarCwid", () => {
  it("accepts an active, publicly displayed scholar", async () => {
    mockScholarFindFirst.mockResolvedValue({ roleCategory: "full_time_faculty" });
    await expect(isPublicScholarCwid("aaa1111")).resolves.toBe(true);
    const where = mockScholarFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ cwid: "aaa1111", deletedAt: null, status: "active" });
    // The #536 population gate is part of the query itself.
    expect(where.OR).toBeDefined();
  });

  it("refuses an unknown cwid", async () => {
    mockScholarFindFirst.mockResolvedValue(null);
    await expect(isPublicScholarCwid("zzz9999")).resolves.toBe(false);
  });

  it("refuses a hidden role the denylist cannot express (fail-closed prefix check)", async () => {
    mockScholarFindFirst.mockResolvedValue({ roleCategory: "doctoral_student_xyz" });
    await expect(isPublicScholarCwid("bbb2222")).resolves.toBe(false);
  });

  it("refuses a malformed cwid without querying", async () => {
    await expect(isPublicScholarCwid("AAA-1")).resolves.toBe(false);
    expect(mockScholarFindFirst).not.toHaveBeenCalled();
  });

  it("loadHiddenAuthorshipPmids reads only this scholar's live per-author hides", async () => {
    mockSuppressionFindMany.mockResolvedValue([{ entityId: "9" }, { entityId: "9" }]);
    await expect(loadHiddenAuthorshipPmids("aaa1111")).resolves.toEqual(["9"]);
    expect(mockSuppressionFindMany.mock.calls[0][0].where).toEqual({
      entityType: "publication",
      contributorCwid: "aaa1111",
      revokedAt: null,
    });
  });
});

describe("getTopicPublications({ cwid })", () => {
  it("a hidden cwid returns the empty shape and never runs the feed query", async () => {
    mockTopicFindUnique.mockResolvedValue(TOPIC);
    mockScholarFindFirst.mockResolvedValue({ roleCategory: "doctoral_student" });
    const hidden = await getTopicPublications("cardio", { sort: "newest", cwid: "bbb2222" });
    mockScholarFindFirst.mockResolvedValue(null);
    const unknown = await getTopicPublications("cardio", { sort: "newest", cwid: "zzz9999" });
    expect(hidden).toEqual(unknown);
    expect(hidden!.hits).toEqual([]);
    expect(hidden!.total).toBe(0);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPublicationTopicFindMany).not.toHaveBeenCalled();
  });

  it("scopes the page query and every count to the scholar, minus their per-author hides", async () => {
    mockTopicFindUnique.mockResolvedValue(TOPIC);
    mockScholarFindFirst.mockResolvedValue({ roleCategory: "full_time_faculty" });
    // The hide lookup (contributorCwid) returns one pmid; later page-scoped
    // suppression loads return nothing.
    mockSuppressionFindMany.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.contributorCwid ? [{ entityId: "77" }] : []),
    );
    mockTransaction.mockResolvedValue([[], ...Array.from({ length: 7 }, () => count(0))]);

    await getTopicPublications("cardio", { sort: "newest", cwid: "aaa1111" });

    const where = mockPublicationTopicFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      parentTopicId: "cardio",
      cwid: "aaa1111",
      pmid: { notIn: ["77"] },
    });
    // All seven COUNT(DISTINCT pmid) queries carry the cwid + the hide exclusion.
    expect(mockQueryRaw).toHaveBeenCalledTimes(7);
    for (const call of mockQueryRaw.mock.calls) {
      const sql = call[1] as Prisma.Sql;
      expect(sql.sql).toContain("pt.cwid = ?");
      expect(sql.sql).toContain("pt.pmid NOT IN");
      expect(sql.values).toContain("aaa1111");
      expect(sql.values).toContain("77");
    }
  });

  it("no cwid → no scholar lookup and no cwid predicate (pre-flag behavior)", async () => {
    mockTopicFindUnique.mockResolvedValue(TOPIC);
    mockTransaction.mockResolvedValue([[], ...Array.from({ length: 7 }, () => count(0))]);
    await getTopicPublications("cardio", { sort: "newest" });
    expect(mockScholarFindFirst).not.toHaveBeenCalled();
    expect(mockPublicationTopicFindMany.mock.calls[0][0].where.cwid).toBeUndefined();
    for (const call of mockQueryRaw.mock.calls) {
      expect((call[1] as Prisma.Sql).sql).not.toContain("pt.cwid");
    }
  });
});

describe("getFamilyPublications({ cwid })", () => {
  const SC = "imaging_image_analysis";

  function wire(opts: { scholarRow: string[] | null }) {
    mockScholarFamilyFindMany.mockImplementation((args: { where: Record<string, unknown> }) => {
      // The scholar's own (cwid, family) row.
      if (args.where.cwid) {
        return Promise.resolve(opts.scholarRow ? [{ pmids: opts.scholarRow }] : []);
      }
      // The family's gated union across every active scholar.
      return Promise.resolve([{ pmids: ["1", "2", "3"] }, { pmids: ["3", "4"] }]);
    });
    mockTransaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
    mockPublicationCount.mockResolvedValue(0);
  }

  const feedPmids = () => {
    const call = mockPublicationFindMany.mock.calls.find(
      (c) => c[0].take !== undefined && c[0].where?.pmid?.in,
    );
    return new Set(call![0].where.pmid.in as string[]);
  };

  it("intersects the family union with the scholar's ScholarFamily.pmids, minus their hides", async () => {
    wire({ scholarRow: ["2", "4", "99"] }); // 99 is not in the gated family union
    mockScholarFindFirst.mockResolvedValue({ roleCategory: "postdoc" });
    mockSuppressionFindMany.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.contributorCwid ? [{ entityId: "4" }] : []),
    );

    await getFamilyPublications(SC, "MRI", { sort: "newest", cwid: "aaa1111" });

    expect(feedPmids()).toEqual(new Set(["2"]));
    const own = mockScholarFamilyFindMany.mock.calls.find((c) => c[0].where.cwid);
    expect(own![0].where).toEqual({ cwid: "aaa1111", supercategory: SC, familyLabel: "MRI" });
  });

  it("a hidden cwid gets the same result as an unknown one: an empty feed", async () => {
    wire({ scholarRow: ["1", "2"] });
    mockPublicationCount.mockResolvedValue(4);
    mockScholarFindFirst.mockResolvedValue({ roleCategory: "affiliate_alumni" });
    const hidden = await getFamilyPublications(SC, "MRI", { sort: "newest", cwid: "bbb2222" });
    expect(feedPmids()).toEqual(new Set());

    mockPublicationFindMany.mockClear();
    mockScholarFindFirst.mockResolvedValue(null);
    const unknown = await getFamilyPublications(SC, "MRI", { sort: "newest", cwid: "zzz9999" });
    expect(feedPmids()).toEqual(new Set());
    expect(hidden).toEqual(unknown);
    // The hidden scholar's own row is never even read.
    expect(mockScholarFamilyFindMany.mock.calls.some((c) => c[0].where.cwid)).toBe(false);
  });

  it("a suppressed family stays a 404 (null) even with a cwid", async () => {
    wire({ scholarRow: ["1"] });
    mockSuppressionOverlayFindMany.mockResolvedValue([{ supercategory: SC, familyLabel: "MRI" }]);
    mockScholarFindFirst.mockResolvedValue({ roleCategory: "full_time_faculty" });
    await expect(
      getFamilyPublications(SC, "MRI", { sort: "newest", cwid: "aaa1111" }),
    ).resolves.toBeNull();
    expect(mockScholarFindFirst).not.toHaveBeenCalled();
  });
});
