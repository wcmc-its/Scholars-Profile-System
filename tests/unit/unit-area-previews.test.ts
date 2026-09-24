/**
 * Research-area hover preview loader (`lib/api/unit-area-previews.ts`).
 *
 * The contract that matters: for a given (unit, area) the preview's `where` is
 * the SAME object the unit's area-filtered Publications tab uses, so "See all
 * N" equals the tab's total and the 3 preview papers are its first 3 rows
 * under "Most cited". Fixtures are fake (public repo).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPublicationCount,
  mockPublicationFindMany,
  mockScholarFindMany,
  mockCenterMembershipFindMany,
  mockDivisionFindFirst,
  mockDivisionMembershipFindMany,
  mockLoadAllSuppressions,
  mockResolveUnitDarkPmids,
  cacheKeys,
} = vi.hoisted(() => ({
  mockPublicationCount: vi.fn(),
  mockPublicationFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockCenterMembershipFindMany: vi.fn(),
  mockDivisionFindFirst: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockLoadAllSuppressions: vi.fn(),
  mockResolveUnitDarkPmids: vi.fn(),
  cacheKeys: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publication: { count: mockPublicationCount, findMany: mockPublicationFindMany },
    scholar: { findMany: mockScholarFindMany },
    centerMembership: { findMany: mockCenterMembershipFindMany },
    division: { findFirst: mockDivisionFindFirst },
    divisionMembership: { findMany: mockDivisionMembershipFindMany },
  },
}));

vi.mock("@/lib/api/swr-cache", () => ({
  cachedRead: (key: string, load: () => Promise<unknown>) => {
    cacheKeys.push(key);
    return load();
  },
  bust: () => {},
}));

vi.mock("@/lib/api/manual-layer", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/manual-layer")>("@/lib/api/manual-layer");
  return {
    ...actual,
    loadAllPublicationSuppressions: mockLoadAllSuppressions,
    resolveUnitDarkPmids: mockResolveUnitDarkPmids,
  };
});

import {
  applyAreaPreviewCounts,
  getUnitAreaPreviews,
} from "@/lib/api/unit-area-previews";
import { getDeptPublicationsList } from "@/lib/api/dept-lists";
import { getCenterPublicationsList } from "@/lib/api/centers";
import { getDivisionPublicationsList } from "@/lib/api/divisions";

const NO_SUPPRESSIONS = { darkPmids: new Set<string>(), hiddenAuthorsByPmid: new Map() };

function pub(pmid: string, extra: Record<string, unknown> = {}) {
  return {
    pmid,
    title: `Fake paper ${pmid}`,
    journal: "Journal of Examples",
    year: 2024,
    doi: null,
    pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    citationCount: 10,
    authors: [{ cwid: "aaa0001" }],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheKeys.length = 0;
  mockLoadAllSuppressions.mockResolvedValue(NO_SUPPRESSIONS);
  mockResolveUnitDarkPmids.mockResolvedValue([]);
  mockPublicationCount.mockResolvedValue(0);
  mockPublicationFindMany.mockResolvedValue([]);
  mockScholarFindMany.mockResolvedValue([]);
  mockCenterMembershipFindMany.mockResolvedValue([]);
  mockDivisionFindFirst.mockResolvedValue({ source: "ldap" });
  mockDivisionMembershipFindMany.mockResolvedValue([]);
});

describe("getUnitAreaPreviews — bounded fan-out", () => {
  it("computes at most 2 areas at once and keeps every area's result", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = <T>(value: T) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise<T>((resolve) =>
        setTimeout(() => {
          inFlight--;
          resolve(value);
        }, 1),
      );
    };
    mockPublicationCount.mockImplementation(() => slow(4));
    mockPublicationFindMany.mockImplementation(() => slow([pub("100001")]));

    const areas = Array.from({ length: 10 }, (_, i) => `topic_${i}`);
    const out = await getUnitAreaPreviews("department", "DEPT1", areas);

    // 2 areas x (count + findMany) — never all 10 areas' queries at once.
    expect(peak).toBeLessThanOrEqual(4);
    expect(mockPublicationCount).toHaveBeenCalledTimes(10);
    expect(Object.keys(out)).toEqual(areas);
    expect(out.topic_9.total).toBe(4);
  });
});

describe("getUnitAreaPreviews — same predicate as the filtered Publications tab", () => {
  it("department: count + top-3 where deep-equals getDeptPublicationsList's with the same area", async () => {
    mockResolveUnitDarkPmids.mockResolvedValue(["900009"]);
    mockPublicationCount.mockResolvedValue(5);

    await getUnitAreaPreviews("department", "DEPT1", ["topic_a"]);
    const previewCountWhere = mockPublicationCount.mock.calls[0][0].where;
    const previewFindWhere = mockPublicationFindMany.mock.calls[0][0].where;
    expect(previewFindWhere).toEqual(previewCountWhere);

    vi.clearAllMocks();
    mockLoadAllSuppressions.mockResolvedValue(NO_SUPPRESSIONS);
    mockResolveUnitDarkPmids.mockResolvedValue(["900009"]);
    mockPublicationCount.mockResolvedValue(5);
    mockPublicationFindMany.mockResolvedValue([]);
    await getDeptPublicationsList("DEPT1", { page: 0, sort: "most_cited", area: "topic_a" });
    const tabWhere = mockPublicationCount.mock.calls[0][0].where;

    expect(previewCountWhere).toEqual(tabWhere);
    expect(previewCountWhere.publicationTopics).toEqual({
      some: {
        parentTopicId: "topic_a",
        scholar: { deptCode: "DEPT1", deletedAt: null, status: "active" },
      },
    });
    // Dark pmids are excluded.
    expect(previewCountWhere.pmid).toEqual({ notIn: ["900009"] });
  });

  it("center: membership is the active-member cwid list, same where as the center tab", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "aaa0001", startDate: null, endDate: null, membershipRoleKey: null },
    ]);
    mockScholarFindMany.mockResolvedValue([{ cwid: "aaa0001" }]);
    mockPublicationCount.mockResolvedValue(2);

    await getUnitAreaPreviews("center", "CTR1", ["topic_b"]);
    const previewWhere = mockPublicationCount.mock.calls[0][0].where;

    mockPublicationCount.mockClear();
    await getCenterPublicationsList("CTR1", { page: 0, sort: "most_cited", area: "topic_b" });
    const tabWhere = mockPublicationCount.mock.calls[0][0].where;

    expect(previewWhere).toEqual(tabWhere);
    expect(previewWhere.authors).toEqual({
      some: { isConfirmed: true, cwid: { in: ["aaa0001"] } },
    });
  });

  it("division: same where as the division tab", async () => {
    mockScholarFindMany.mockResolvedValue([{ cwid: "aaa0003" }]);
    mockPublicationCount.mockResolvedValue(1);

    await getUnitAreaPreviews("division", "DIV1", ["topic_c"]);
    const previewWhere = mockPublicationCount.mock.calls[0][0].where;

    mockPublicationCount.mockClear();
    await getDivisionPublicationsList("DIV1", { page: 0, sort: "most_cited", area: "topic_c" });
    const tabWhere = mockPublicationCount.mock.calls[0][0].where;

    expect(previewWhere).toEqual(tabWhere);
  });

  it("orders by citationCount desc then pmid asc, take 3 — the tab's 'Most cited' order", async () => {
    await getUnitAreaPreviews("department", "DEPT1", ["topic_a"]);
    const args = mockPublicationFindMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ citationCount: "desc" }, { pmid: "asc" }]);
    expect(args.take).toBe(3);
  });
});

describe("getUnitAreaPreviews — shape", () => {
  it("counts distinct unit authors, excluding one who hid the paper", async () => {
    mockLoadAllSuppressions.mockResolvedValue({
      darkPmids: new Set<string>(),
      hiddenAuthorsByPmid: new Map([["100001", new Set(["aaa0002"])]]),
    });
    mockPublicationCount.mockResolvedValue(1);
    mockPublicationFindMany.mockResolvedValue([
      pub("100001", {
        authors: [{ cwid: "aaa0001" }, { cwid: "aaa0002" }, { cwid: "aaa0003" }, { cwid: "aaa0001" }],
      }),
    ]);

    const out = await getUnitAreaPreviews("department", "DEPT1", ["topic_a"]);
    expect(out.topic_a.total).toBe(1);
    expect(out.topic_a.papers[0].unitAuthorCount).toBe(2);
    // The author select is the confirmed-member predicate.
    expect(mockPublicationFindMany.mock.calls[0][0].select.authors.where).toEqual({
      isConfirmed: true,
      scholar: { deptCode: "DEPT1", deletedAt: null, status: "active" },
    });
  });

  it("href prefers the DOI over the PubMed URL", async () => {
    mockPublicationFindMany.mockResolvedValue([
      pub("100001", { doi: "10.0000/fake.1" }),
      pub("100002"),
      pub("100003", { pubmedUrl: null }),
    ]);
    const out = await getUnitAreaPreviews("department", "DEPT1", ["topic_a"]);
    expect(out.topic_a.papers.map((p) => p.href)).toEqual([
      "https://doi.org/10.0000/fake.1",
      "https://pubmed.ncbi.nlm.nih.gov/100002/",
      null,
    ]);
    expect(out.topic_a.papers[0]).toMatchObject({
      title: "Fake paper 100001",
      venue: "Journal of Examples",
      year: 2024,
    });
  });

  it("empty topic list → {} and no publication queries", async () => {
    expect(await getUnitAreaPreviews("department", "DEPT1", [])).toEqual({});
    expect(mockPublicationCount).not.toHaveBeenCalled();
    expect(mockPublicationFindMany).not.toHaveBeenCalled();
  });

  it("a center with no active members → {} and no publication queries", async () => {
    expect(await getUnitAreaPreviews("center", "CTR1", ["topic_b"])).toEqual({});
    expect(mockPublicationCount).not.toHaveBeenCalled();
    expect(mockPublicationFindMany).not.toHaveBeenCalled();
  });

  it("caches under the unit-kind prefix so the existing bust() calls clear it", async () => {
    await getUnitAreaPreviews("department", "DEPT1", ["topic_a", "topic_b"]);
    await getUnitAreaPreviews("center", "CTR1", ["topic_a"]);
    await getUnitAreaPreviews("division", "DIV1", ["topic_a"]);
    const keys = cacheKeys.filter((k) => k.includes(":areapreview:"));
    expect(keys).toEqual([
      "department:areapreview:DEPT1:topic_a,topic_b",
      "center:areapreview:CTR1:topic_a",
      "division:areapreview:DIV1:topic_a",
    ]);
  });
});

describe("area filter changes the Publications-tab cache key", () => {
  it("department, center and division keys carry the area (or '-')", async () => {
    await getDeptPublicationsList("DEPT1", { page: 0, sort: "most_cited" });
    await getDeptPublicationsList("DEPT1", { page: 0, sort: "most_cited", area: "topic_a" });
    await getCenterPublicationsList("CTR1", { page: 0, sort: "newest", area: "topic_a" });
    await getDivisionPublicationsList("DIV1", { page: 1, sort: "newest", area: "topic_a" });
    expect(cacheKeys).toEqual([
      "department:pubs:DEPT1:0:most_cited:-",
      "department:pubs:DEPT1:0:most_cited:topic_a",
      "center:pubs:CTR1:0:newest:topic_a",
      "division:pubs:DIV1:1:newest:topic_a",
    ]);
  });
});

describe("applyAreaPreviewCounts", () => {
  const area = (topicId: string, pubCount: number) => ({
    topicId,
    topicLabel: topicId,
    topicSlug: topicId,
    pubCount,
  });

  it("uses the preview total as the pill count and re-sorts by it (stable)", () => {
    const out = applyAreaPreviewCounts(
      [area("a", 30), area("b", 20), area("c", 10), area("d", 5)],
      {
        a: { total: 8, papers: [] },
        b: { total: 12, papers: [] },
        c: { total: 8, papers: [] },
      },
    );
    expect(out.map((a) => [a.topicId, a.pubCount])).toEqual([
      ["b", 12],
      ["a", 8],
      ["c", 8],
      ["d", 5],
    ]);
  });

  it("drops an area whose visible total is 0", () => {
    const out = applyAreaPreviewCounts([area("a", 3), area("b", 2)], {
      a: { total: 0, papers: [] },
    });
    expect(out.map((a) => a.topicId)).toEqual(["b"]);
  });
});
