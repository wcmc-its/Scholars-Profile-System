import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPublicationAuthorFindMany,
  mockSuppressionFindMany,
  mockPublicationFindMany,
  mockScholarFindMany,
} = vi.hoisted(() => ({
  mockPublicationAuthorFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockPublicationFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    suppression: { findMany: mockSuppressionFindMany },
    publication: { findMany: mockPublicationFindMany },
    scholar: { findMany: mockScholarFindMany },
  },
}));

import { resolveDarkPmids, type PublicationSuppressions } from "@/lib/api/manual-layer";
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
  mockScholarFindMany.mockReset().mockResolvedValue([]);
});

describe("getDeptPublicationsList — publication suppression", () => {
  it("drops a taken-down publication from the list and the total", async () => {
    mockPublicationAuthorFindMany.mockResolvedValue([{ pmid: "100" }, { pmid: "200" }]);
    mockSuppressionFindMany.mockResolvedValue([{ entityId: "200", contributorCwid: null }]);
    mockPublicationFindMany.mockResolvedValue([pubRow("100", [{ cwid: "x" }])]);
    mockScholarFindMany.mockResolvedValue([
      { cwid: "x", preferredName: "X", slug: "x-slug" },
    ]);

    const result = await getDeptPublicationsList("DEPT");
    expect(result.total).toBe(1);
    expect(result.hits.map((h) => h.pmid)).toEqual(["100"]);
    // The page is fetched over the visible pmid set only.
    expect(mockPublicationFindMany.mock.calls[0][0].where.pmid.in).toEqual(["100"]);
  });

  it("omits a hidden co-author from a kept publication's chips", async () => {
    mockPublicationAuthorFindMany
      .mockResolvedValueOnce([{ pmid: "100" }]) // pool
      .mockResolvedValueOnce([
        { pmid: "100", cwid: "owner" },
        { pmid: "100", cwid: "co1" },
      ]); // resolveDarkPmids derived-dark probe
    mockSuppressionFindMany.mockResolvedValue([{ entityId: "100", contributorCwid: "co1" }]);
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
  });
});
