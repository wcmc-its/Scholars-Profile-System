import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPublicationAuthorFindMany,
  mockSuppressionFindMany,
  mockPublicationFindMany,
  mockPublicationCount,
  mockScholarFindMany,
} = vi.hoisted(() => ({
  mockPublicationAuthorFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockPublicationFindMany: vi.fn(),
  mockPublicationCount: vi.fn(),
  mockScholarFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    suppression: { findMany: mockSuppressionFindMany },
    publication: { findMany: mockPublicationFindMany, count: mockPublicationCount },
    scholar: { findMany: mockScholarFindMany },
  },
}));

import {
  loadHiddenAuthorshipCounts,
  resolveDarkPmids,
  resolveUnitDarkPmids,
  type PublicationSuppressions,
} from "@/lib/api/manual-layer";
import { getDeptPublicationsList } from "@/lib/api/dept-lists";

type PaClient = Parameters<typeof resolveDarkPmids>[2];

function paClient(rows: Array<{ pmid: string; cwid: string | null }>): {
  client: PaClient;
  findMany: ReturnType<typeof vi.fn>;
} {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { client: { publicationAuthor: { findMany } } as unknown as PaClient, findMany };
}

describe("resolveDarkPmids", () => {
  it("includes an explicit whole-publication takedown without an extra query", async () => {
    const sup: PublicationSuppressions = {
      darkPmids: new Set(["100"]),
      hiddenAuthorsByPmid: new Map(),
    };
    const { client, findMany } = paClient([]);
    const dark = await resolveDarkPmids(["100", "200"], sup, client);
    expect([...dark]).toEqual(["100"]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("derives darkness when every confirmed WCM author is per-author-hidden", async () => {
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["300", new Set(["a", "b"])]]),
    };
    const { client } = paClient([
      { pmid: "300", cwid: "a" },
      { pmid: "300", cwid: "b" },
    ]);
    expect((await resolveDarkPmids(["300"], sup, client)).has("300")).toBe(true);
  });

  it("does not darken a publication that still has a displayed author", async () => {
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["300", new Set(["a"])]]),
    };
    const { client } = paClient([
      { pmid: "300", cwid: "a" },
      { pmid: "300", cwid: "b" },
    ]);
    expect((await resolveDarkPmids(["300"], sup, client)).has("300")).toBe(false);
  });

  it("returns an empty set and issues no query when nothing is suppressed", async () => {
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map(),
    };
    const { client, findMany } = paClient([]);
    const dark = await resolveDarkPmids(["1", "2"], sup, client);
    expect(dark.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

/** A publication row in the shape getDeptPublicationsList selects. */
function pubRow(pmid: string, authors: Array<{ cwid: string }>) {
  return {
    pmid,
    title: `Title ${pmid}`,
    journal: "Journal",
    year: 2024,
    citationCount: 0,
    doi: null,
    pubmedUrl: null,
    authors: authors.map((a, i) => ({
      cwid: a.cwid,
      isFirst: i === 0,
      isLast: i === authors.length - 1,
      position: i + 1,
    })),
  };
}

beforeEach(() => {
  mockPublicationAuthorFindMany.mockReset();
  mockSuppressionFindMany.mockReset().mockResolvedValue([]);
  mockPublicationFindMany.mockReset().mockResolvedValue([]);
  mockPublicationCount.mockReset().mockResolvedValue(0);
  mockScholarFindMany.mockReset().mockResolvedValue([]);
});

describe("resolveUnitDarkPmids", () => {
  it("returns [] without querying when nothing is suppressed", async () => {
    const findMany = vi.fn();
    const client = { publicationAuthor: { findMany } } as unknown as PaClient;
    const out = await resolveUnitDarkPmids(
      { darkPmids: new Set(), hiddenAuthorsByPmid: new Map() },
      { cwid: { in: ["u1"] } },
      client,
    );
    expect(out).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("intersects the sitewide dark set with the unit's membership", async () => {
    // 100 and 200 are explicit sitewide takedowns; only 100 is in this unit.
    const findMany = vi.fn().mockResolvedValue([{ pmid: "100" }]);
    const client = { publicationAuthor: { findMany } } as unknown as PaClient;
    const out = await resolveUnitDarkPmids(
      { darkPmids: new Set(["100", "200"]), hiddenAuthorsByPmid: new Map() },
      { cwid: { in: ["u1"] } },
      client,
    );
    expect(out).toEqual(["100"]);
    // The unit query is scoped to the sitewide dark set + membership + confirmed.
    const where = findMany.mock.calls.at(-1)![0].where;
    expect(new Set(where.pmid.in)).toEqual(new Set(["100", "200"]));
    expect(where.isConfirmed).toBe(true);
    expect(where.cwid).toEqual({ in: ["u1"] });
  });
});

describe("getDeptPublicationsList — publication suppression", () => {
  it("drops a taken-down publication from the list and the total", async () => {
    // loadAllPublicationSuppressions: pmid 200 is a whole-publication takedown.
    mockSuppressionFindMany.mockResolvedValue([{ entityId: "200", contributorCwid: null }]);
    // resolveUnitDarkPmids: 200 belongs to this dept (the unit-dark query).
    mockPublicationAuthorFindMany.mockResolvedValue([{ pmid: "200" }]);
    mockPublicationCount.mockResolvedValue(1); // total over the visible set
    mockPublicationFindMany.mockResolvedValue([pubRow("100", [{ cwid: "x" }])]);
    mockScholarFindMany.mockResolvedValue([
      { cwid: "x", preferredName: "X", slug: "x-slug" },
    ]);

    const result = await getDeptPublicationsList("DEPT");
    expect(result.total).toBe(1);
    expect(result.hits.map((h) => h.pmid)).toEqual(["100"]);
    // The page + count filter by membership and exclude the unit's dark pmids.
    const pageWhere = mockPublicationFindMany.mock.calls[0][0].where;
    expect(pageWhere.pmid.notIn).toEqual(["200"]);
    expect(pageWhere.authors.some.scholar.deptCode).toBe("DEPT");
    expect(mockPublicationCount.mock.calls[0][0].where.pmid.notIn).toEqual(["200"]);
  });

  it("omits a hidden co-author from a kept publication's chips", async () => {
    // co1 is per-author-hidden on pmid 100 (a partial hide, not a takedown), so
    // 100 is NOT dark (owner still displayed) and stays in the list; only the
    // co1 chip drops.
    mockSuppressionFindMany.mockResolvedValue([{ entityId: "100", contributorCwid: "co1" }]);
    // resolveDarkPmids' derived-dark probe: owner + co1 both confirmed authors.
    mockPublicationAuthorFindMany.mockResolvedValue([
      { pmid: "100", cwid: "owner" },
      { pmid: "100", cwid: "co1" },
    ]);
    mockPublicationCount.mockResolvedValue(1);
    mockPublicationFindMany.mockResolvedValue([
      pubRow("100", [{ cwid: "owner" }, { cwid: "co1" }]),
    ]);
    mockScholarFindMany.mockResolvedValue([
      { cwid: "owner", preferredName: "Owner", slug: "owner-slug" },
      { cwid: "co1", preferredName: "Co One", slug: "co1-slug" },
    ]);

    const result = await getDeptPublicationsList("DEPT");
    expect(result.hits.map((h) => h.pmid)).toEqual(["100"]);
    expect(result.hits[0].authors.map((a) => a.cwid)).toEqual(["owner"]);
    // 100 is not dark → not excluded from the page window.
    expect(mockPublicationFindMany.mock.calls[0][0].where.pmid).toBeUndefined();
  });
});

describe("loadHiddenAuthorshipCounts", () => {
  function supClient(rows: Array<{ contributorCwid: string | null }>) {
    return {
      suppression: { findMany: vi.fn().mockResolvedValue(rows) },
    } as unknown as Parameters<typeof loadHiddenAuthorshipCounts>[1];
  }

  it("tallies active per-author hides per cwid", async () => {
    const counts = await loadHiddenAuthorshipCounts(
      ["a", "b"],
      supClient([
        { contributorCwid: "a" },
        { contributorCwid: "a" },
        { contributorCwid: "b" },
      ]),
    );
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
  });

  it("ignores whole-publication takedown rows (null contributor)", async () => {
    const counts = await loadHiddenAuthorshipCounts(
      ["a"],
      supClient([{ contributorCwid: null }, { contributorCwid: "a" }]),
    );
    expect(counts.get("a")).toBe(1);
  });

  it("returns an empty map when given no cwids", async () => {
    const counts = await loadHiddenAuthorshipCounts([], supClient([]));
    expect(counts.size).toBe(0);
  });
});
