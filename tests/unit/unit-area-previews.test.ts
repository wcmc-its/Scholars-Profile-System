/**
 * Research-area hover preview loader (`lib/api/unit-area-previews.ts`).
 *
 * The contract that matters: for a given (unit, area) the preview's `total`
 * is the unit's area-filtered Publications tab total and its 3 papers are
 * that tab's first 3 rows under "Most cited" — the tab's predicate is
 * `unitPublicationWhere`, the preview's is the ONE batched ranking statement
 * `areaPreviewRankSql`. These tests pin the SQL's clauses (membership, the
 * confirmed-author EXISTS, dark-pmid suppression, the order) and the
 * assembly; row-for-row parity against the Prisma predicate was checked on a
 * database (see the PR). Fixtures are fake (public repo).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockQueryRaw,
  mockPublicationCount,
  mockPublicationFindMany,
  mockPublicationAuthorFindMany,
  mockScholarFindMany,
  mockCenterMembershipFindMany,
  mockDivisionFindFirst,
  mockDivisionMembershipFindMany,
  mockLoadAllSuppressions,
  mockResolveUnitDarkPmids,
  cacheKeys,
} = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockPublicationCount: vi.fn(),
  mockPublicationFindMany: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
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
    $queryRaw: mockQueryRaw,
    publication: { count: mockPublicationCount, findMany: mockPublicationFindMany },
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
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
  areaPreviewRankSql,
  getUnitAreaPreviews,
} from "@/lib/api/unit-area-previews";
import { unitPublicationWhere } from "@/lib/api/unit-publication-where";
import { getDeptPublicationsList } from "@/lib/api/dept-lists";
import { getCenterPublicationsList } from "@/lib/api/centers";
import { getDivisionPublicationsList } from "@/lib/api/divisions";

const NO_SUPPRESSIONS = { darkPmids: new Set<string>(), hiddenAuthorsByPmid: new Map() };
const DEPT_MEMBERSHIP = { scholar: { deptCode: "DEPT1", deletedAt: null, status: "active" } };

function pub(pmid: string, extra: Record<string, unknown> = {}) {
  return {
    pmid,
    title: `Fake paper ${pmid}`,
    journal: "Journal of Examples",
    year: 2024,
    doi: null,
    pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    ...extra,
  };
}

/** A ranking row as the statement returns it (MariaDB hands back BigInts). */
function rank(area: string, pmid: string, total: number, rn: number) {
  return { area, pmid, total: BigInt(total), rn: BigInt(rn) };
}

/** Whitespace-normalized SQL text of a `Prisma.Sql`. */
function sqlText(q: { sql: string }): string {
  return q.sql.replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheKeys.length = 0;
  mockLoadAllSuppressions.mockResolvedValue(NO_SUPPRESSIONS);
  mockResolveUnitDarkPmids.mockResolvedValue([]);
  mockQueryRaw.mockResolvedValue([]);
  mockPublicationCount.mockResolvedValue(0);
  mockPublicationFindMany.mockResolvedValue([]);
  mockPublicationAuthorFindMany.mockResolvedValue([]);
  mockScholarFindMany.mockResolvedValue([]);
  mockCenterMembershipFindMany.mockResolvedValue([]);
  mockDivisionFindFirst.mockResolvedValue({ source: "ldap" });
  mockDivisionMembershipFindMany.mockResolvedValue([]);
});

describe("getUnitAreaPreviews — one statement for every area", () => {
  it("ranks all areas in ONE query, then one publication + one author read", async () => {
    mockQueryRaw.mockResolvedValue([
      rank("topic_0", "100001", 4, 1),
      rank("topic_9", "100002", 2, 1),
    ]);
    mockPublicationFindMany.mockResolvedValue([pub("100001"), pub("100002")]);
    const areas = Array.from({ length: 10 }, (_, i) => `topic_${i}`);
    const out = await getUnitAreaPreviews("department", "DEPT1", areas);

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(mockPublicationCount).not.toHaveBeenCalled();
    expect(mockPublicationFindMany).toHaveBeenCalledTimes(1);
    expect(mockPublicationAuthorFindMany).toHaveBeenCalledTimes(1);
    // Every requested area keeps an entry, in request order.
    expect(Object.keys(out)).toEqual(areas);
    expect(out.topic_0.total).toBe(4);
    expect(out.topic_9.total).toBe(2);
    // An area the statement returned nothing for is a 0 — its pill is dropped.
    expect(out.topic_5).toEqual({ total: 0, papers: [] });
  });

  it("no ranked rows → no publication / author reads", async () => {
    const out = await getUnitAreaPreviews("department", "DEPT1", ["topic_a"]);
    expect(out).toEqual({ topic_a: { total: 0, papers: [] } });
    expect(mockPublicationFindMany).not.toHaveBeenCalled();
    expect(mockPublicationAuthorFindMany).not.toHaveBeenCalled();
  });
});

describe("areaPreviewRankSql — the Publications tab's predicate, in SQL", () => {
  it("tripwire: unitPublicationWhere still has exactly the clauses the SQL mirrors", () => {
    // If a clause is added to unitPublicationWhere, add it to areaPreviewRankSql
    // too (or the pill count and its "See all" destination disagree), then
    // update this list.
    const where = unitPublicationWhere({
      membership: DEPT_MEMBERSHIP,
      darkPmids: ["900009"],
      area: "topic_a",
    });
    expect(Object.keys(where).sort()).toEqual(["authors", "pmid", "publicationTopics"]);
    expect(where.authors).toEqual({ some: { isConfirmed: true, ...DEPT_MEMBERSHIP } });
    expect(where.publicationTopics).toEqual({
      some: { parentTopicId: "topic_a", ...DEPT_MEMBERSHIP },
    });
  });

  it("department: member = active, non-deleted scholar in the dept, on BOTH the topic and the author row", () => {
    const q = areaPreviewRankSql({ membership: DEPT_MEMBERSHIP, darkPmids: [], areas: ["topic_a"] });
    const sql = sqlText(q);
    expect(sql).toContain("JOIN scholar pt_s ON pt_s.cwid = pt.cwid");
    expect(sql).toContain(
      "pt_s.dept_code = ? AND pt_s.deleted_at IS NULL AND pt_s.status = ?",
    );
    expect(sql).toContain("JOIN scholar pa_s ON pa_s.cwid = pa.cwid");
    expect(sql).toContain(
      "pa_s.dept_code = ? AND pa_s.deleted_at IS NULL AND pa_s.status = ?",
    );
    expect(q.values).toEqual(["topic_a", "DEPT1", "active", "DEPT1", "active", 3]);
  });

  it("center / division: member = cwid in the list, on BOTH the topic and the author row", () => {
    const q = areaPreviewRankSql({
      membership: { cwid: { in: ["aaa0001", "aaa0002"] } },
      darkPmids: [],
      areas: ["topic_a", "topic_b"],
    });
    const sql = sqlText(q);
    expect(sql).toContain("pt.cwid IN (?,?)");
    expect(sql).toContain("pa.cwid IN (?,?)");
    expect(sql).not.toContain("scholar");
    expect(q.values).toEqual(["topic_a", "topic_b", "aaa0001", "aaa0002", "aaa0001", "aaa0002", 3]);
  });

  it("requires a CONFIRMED member author, and a member topic row for the area", () => {
    const sql = sqlText(
      areaPreviewRankSql({ membership: DEPT_MEMBERSHIP, darkPmids: [], areas: ["topic_a"] }),
    );
    expect(sql).toContain("WHERE pt.parent_topic_id IN (?)");
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM publication_author pa .* WHERE pa\.pmid = ap\.pmid AND pa\.is_confirmed = 1/);
  });

  it("suppression: the unit's dark pmids are excluded, and only when there are any", () => {
    const withDark = areaPreviewRankSql({
      membership: DEPT_MEMBERSHIP,
      darkPmids: ["900009", "900010"],
      areas: ["topic_a"],
    });
    expect(sqlText(withDark)).toContain("AND pt.pmid NOT IN (?,?)");
    expect(withDark.values).toEqual(
      expect.arrayContaining(["900009", "900010"]),
    );
    const none = areaPreviewRankSql({ membership: DEPT_MEMBERSHIP, darkPmids: [], areas: ["topic_a"] });
    expect(sqlText(none)).not.toContain("NOT IN");
  });

  it("ranks in the tab's 'Most cited' order and keeps the top 3 plus the full count", () => {
    const sql = sqlText(
      areaPreviewRankSql({ membership: DEPT_MEMBERSHIP, darkPmids: [], areas: ["topic_a"] }),
    );
    expect(sql).toContain("SELECT DISTINCT pt.parent_topic_id AS area, pt.pmid");
    expect(sql).toContain("COUNT(*) OVER (PARTITION BY area) AS total");
    expect(sql).toContain(
      "ROW_NUMBER() OVER (PARTITION BY area ORDER BY citation_count DESC, pmid ASC) AS rn",
    );
    expect(sql).toContain("WHERE rn <= ? ORDER BY area, rn");
  });
});

describe("getUnitAreaPreviews — suppression reaches the optimized path", () => {
  it("passes the unit's resolved dark pmids into the ranking statement", async () => {
    mockResolveUnitDarkPmids.mockResolvedValue(["900009"]);
    await getUnitAreaPreviews("department", "DEPT1", ["topic_a"]);
    // resolveUnitDarkPmids sees the dept membership predicate…
    expect(mockResolveUnitDarkPmids.mock.calls[0][1]).toEqual(DEPT_MEMBERSHIP);
    // …and its result is the statement's NOT IN list.
    const q = mockQueryRaw.mock.calls[0][0];
    expect(sqlText(q)).toContain("AND pt.pmid NOT IN (?)");
    expect(q.values).toContain("900009");
  });

  it("center: the ranking statement is over the active-member cwid list", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "aaa0001", startDate: null, endDate: null, membershipRoleKey: null },
    ]);
    mockScholarFindMany.mockResolvedValue([{ cwid: "aaa0001" }]);
    await getUnitAreaPreviews("center", "CTR1", ["topic_b"]);
    expect(mockResolveUnitDarkPmids.mock.calls[0][1]).toEqual({ cwid: { in: ["aaa0001"] } });
    const q = mockQueryRaw.mock.calls[0][0];
    expect(q.values).toEqual(["topic_b", "aaa0001", "aaa0001", 3]);
  });

  it("division: the ranking statement is over the division's member cwids", async () => {
    mockScholarFindMany.mockResolvedValue([{ cwid: "aaa0003" }]);
    await getUnitAreaPreviews("division", "DIV1", ["topic_c"]);
    const q = mockQueryRaw.mock.calls[0][0];
    expect(q.values).toEqual(["topic_c", "aaa0003", "aaa0003", 3]);
  });
});

describe("getUnitAreaPreviews — shape", () => {
  it("papers follow the statement's rank order; href prefers the DOI", async () => {
    mockQueryRaw.mockResolvedValue([
      rank("topic_a", "100003", 7, 1),
      rank("topic_a", "100001", 7, 2),
      rank("topic_a", "100002", 7, 3),
    ]);
    // The publication read comes back in some other order.
    mockPublicationFindMany.mockResolvedValue([
      pub("100001", { doi: "10.0000/fake.1" }),
      pub("100002"),
      pub("100003", { pubmedUrl: null }),
    ]);
    const out = await getUnitAreaPreviews("department", "DEPT1", ["topic_a"]);
    expect(out.topic_a.total).toBe(7);
    expect(out.topic_a.papers.map((p) => [p.pmid, p.href])).toEqual([
      ["100003", null],
      ["100001", "https://doi.org/10.0000/fake.1"],
      ["100002", "https://pubmed.ncbi.nlm.nih.gov/100002/"],
    ]);
    expect(out.topic_a.papers[1]).toMatchObject({
      title: "Fake paper 100001",
      venue: "Journal of Examples",
      year: 2024,
    });
  });

  it("a paper in two areas is read once and appears under both", async () => {
    mockQueryRaw.mockResolvedValue([rank("topic_a", "100001", 1, 1), rank("topic_b", "100001", 1, 1)]);
    mockPublicationFindMany.mockResolvedValue([pub("100001")]);
    const out = await getUnitAreaPreviews("department", "DEPT1", ["topic_a", "topic_b"]);
    expect(mockPublicationFindMany.mock.calls[0][0].where).toEqual({ pmid: { in: ["100001"] } });
    expect(out.topic_a.papers[0].pmid).toBe("100001");
    expect(out.topic_b.papers[0].pmid).toBe("100001");
  });

  it("counts distinct confirmed member authors, excluding one who hid the paper", async () => {
    mockLoadAllSuppressions.mockResolvedValue({
      darkPmids: new Set<string>(),
      hiddenAuthorsByPmid: new Map([["100001", new Set(["aaa0002"])]]),
    });
    mockQueryRaw.mockResolvedValue([rank("topic_a", "100001", 1, 1), rank("topic_a", "100002", 1, 2)]);
    mockPublicationFindMany.mockResolvedValue([pub("100001"), pub("100002")]);
    mockPublicationAuthorFindMany.mockResolvedValue([
      { pmid: "100001", cwid: "aaa0001" },
      { pmid: "100001", cwid: "aaa0002" },
      { pmid: "100001", cwid: "aaa0003" },
      { pmid: "100001", cwid: "aaa0001" },
      // aaa0002 hid 100001 only — still counts on 100002.
      { pmid: "100002", cwid: "aaa0002" },
    ]);

    const out = await getUnitAreaPreviews("department", "DEPT1", ["topic_a"]);
    expect(out.topic_a.papers.map((p) => p.unitAuthorCount)).toEqual([2, 1]);
    // The author read is the confirmed-member predicate over the result pmids.
    expect(mockPublicationAuthorFindMany.mock.calls[0][0].where).toEqual({
      pmid: { in: ["100001", "100002"] },
      isConfirmed: true,
      scholar: { deptCode: "DEPT1", deletedAt: null, status: "active" },
    });
  });

  it("empty topic list → {} and no queries", async () => {
    expect(await getUnitAreaPreviews("department", "DEPT1", [])).toEqual({});
    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(mockPublicationFindMany).not.toHaveBeenCalled();
  });

  it("a center with no active members → {} and no publication queries", async () => {
    expect(await getUnitAreaPreviews("center", "CTR1", ["topic_b"])).toEqual({});
    expect(mockQueryRaw).not.toHaveBeenCalled();
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
