/**
 * `lib/api/mentoring.ts` — full co-pub LIST source switch (issue #928).
 *
 * `getCoPublications` (powering /scholars/<slug>/co-pubs/<menteeCwid> and the
 * /co-pubs rollup) used to read the WHOLE list from a LIVE ReciterDB query
 * (`analysis_summary_article` + `analysis_summary_author_list`). The SPS VPC
 * can't reach ReciterDB in-VPC, so #928 bridges this list the SAME way #926
 * bridged the count and #928 bridges the AOC list: the export writes
 * `mentoring/copub-list.ndjson` (one RAW `CoPublicationFull[]` per mentor/mentee
 * pair) to S3, the import populates `mentee_copublication_pub` (PK
 * [mentorCwid, menteeCwid, pmid], `pub` JSON = a CoPublicationFull), and the
 * EXISTING `MENTORING_COPUB_BRIDGE` flag selects bridge-vs-live.
 *
 * Suppression is applied AFTER reconstruction on BOTH sources because the
 * bridge stores RAW, pre-suppression rows (a take-down or a per-author hide
 * recorded after the export still takes effect immediately, per ADR-005):
 *  - `resolveDarkPmids` returning a pmid → that publication is dropped.
 *  - `isAuthorHidden(pmid, cwid)` → that author chip is filtered from the pub.
 *
 * Mirrors the `vi.hoisted` mock idiom of mentoring-copub-source.test.ts. Prisma,
 * ReciterDB, and the manual-layer suppression helpers are all mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { withReciterConnection } = vi.hoisted(() => ({
  withReciterConnection: vi.fn(),
}));

const { menteeCopubPubFindMany } = vi.hoisted(() => ({
  menteeCopubPubFindMany: vi.fn(async () => [] as unknown[]),
}));

const { loadPublicationSuppressions, resolveDarkPmids, isAuthorHidden } = vi.hoisted(() => ({
  // Default: nothing suppressed. An empty PublicationSuppressions shape. The
  // spies are declared with their real arity so `mockImplementation` accepts the
  // 3-arg suppression predicates below (a zero-arity `vi.fn` would fail tsc).
  loadPublicationSuppressions: vi.fn(async (_pmids: readonly string[], _client: unknown) => ({
    darkPmids: new Set<string>(),
    hiddenAuthorsByPmid: new Map<string, Set<string>>(),
  })),
  resolveDarkPmids: vi.fn(
    async (_pmids: readonly string[], _suppressions: unknown, _client: unknown) =>
      new Set<string>(),
  ),
  isAuthorHidden: vi.fn((_suppressions: unknown, _pmid: string, _cwid: string): boolean => false),
}));

vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection }));
vi.mock("@/lib/db", () => ({
  prisma: {
    menteeCopublicationPub: { findMany: menteeCopubPubFindMany },
    // loadPublicationSuppressions / resolveDarkPmids receive the prisma client
    // as their second/third arg; the mocked helpers ignore it.
    suppression: { findMany: vi.fn(async () => []) },
    publicationAuthor: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/api/manual-layer", () => ({
  loadPublicationSuppressions,
  resolveDarkPmids,
  isAuthorHidden,
}));

import { getCoPublications, type CoPublicationFull } from "@/lib/api/mentoring";

// A full co-pub record as stored in the bridge `pub` JSON column.
function fullPub(overrides: Partial<CoPublicationFull>): CoPublicationFull {
  return {
    pmid: 111,
    title: "Shared paper",
    journal: "J. Test",
    year: 2021,
    doi: "10.1/x",
    pmcid: null,
    volume: "12",
    issue: "3",
    pages: "1-9",
    citationCount: 7,
    abstract: "An abstract.",
    authors: [
      { rank: 1, lastName: "Mentor", firstName: "Dr", personIdentifier: "mentor01" },
      { rank: 2, lastName: "Student", firstName: "Alex", personIdentifier: "aoc1" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  loadPublicationSuppressions.mockResolvedValue({
    darkPmids: new Set<string>(),
    hiddenAuthorsByPmid: new Map<string, Set<string>>(),
  });
  resolveDarkPmids.mockResolvedValue(new Set<string>());
  isAuthorHidden.mockReturnValue(false);
  menteeCopubPubFindMany.mockResolvedValue([]);
});

afterEach(() => {
  withReciterConnection.mockReset();
  menteeCopubPubFindMany.mockReset();
  loadPublicationSuppressions.mockReset();
  resolveDarkPmids.mockReset();
  isAuthorHidden.mockReset();
  vi.restoreAllMocks();
  delete process.env.MENTORING_COPUB_BRIDGE;
});

describe("getCoPublications — bridge source, flag ON (issue #928)", () => {
  beforeEach(() => {
    process.env.MENTORING_COPUB_BRIDGE = "on";
    withReciterConnection.mockRejectedValue(
      new Error("ReciterDB must not be touched when the bridge is on"),
    );
  });

  it("reconstructs the full list from the bridge table and never calls ReciterDB", async () => {
    menteeCopubPubFindMany.mockResolvedValue([
      { pmid: 222, pub: fullPub({ pmid: 222, year: 2023, title: "Newer" }) },
      { pmid: 111, pub: fullPub({ pmid: 111, year: 2021, title: "Older" }) },
    ]);

    const pubs = await getCoPublications("mentor01", "aoc1");

    expect(withReciterConnection).not.toHaveBeenCalled();
    expect(menteeCopubPubFindMany).toHaveBeenCalled();
    expect(pubs).toHaveLength(2);
    const byPmid = new Map(pubs.map((p) => [p.pmid, p]));
    expect(byPmid.get(222)?.title).toBe("Newer");
    expect(byPmid.get(111)?.title).toBe("Older");
    // Full record fields survive the round-trip through the JSON column.
    expect(byPmid.get(111)?.doi).toBe("10.1/x");
    expect(byPmid.get(111)?.citationCount).toBe(7);
    expect(byPmid.get(111)?.authors).toHaveLength(2);
  });

  it("drops a publication that resolveDarkPmids reports as dark", async () => {
    menteeCopubPubFindMany.mockResolvedValue([
      { pmid: 222, pub: fullPub({ pmid: 222 }) },
      { pmid: 111, pub: fullPub({ pmid: 111 }) },
    ]);
    resolveDarkPmids.mockResolvedValue(new Set<string>(["111"]));

    const pubs = await getCoPublications("mentor01", "aoc1");

    expect(pubs.map((p) => p.pmid)).toEqual([222]);
  });

  it("filters a per-author-hidden co-author chip from a surviving publication", async () => {
    menteeCopubPubFindMany.mockResolvedValue([{ pmid: 111, pub: fullPub({ pmid: 111 }) }]);
    // Hide aoc1 on pmid 111.
    isAuthorHidden.mockImplementation(
      (_suppressions: unknown, pmid: string, cwid: string) => pmid === "111" && cwid === "aoc1",
    );

    const pubs = await getCoPublications("mentor01", "aoc1");

    expect(pubs).toHaveLength(1);
    const ids = pubs[0].authors.map((a) => a.personIdentifier);
    expect(ids).toContain("mentor01");
    expect(ids).not.toContain("aoc1");
  });

  it("returns [] when the bridge table has no rows for this pair", async () => {
    menteeCopubPubFindMany.mockResolvedValue([]);

    const pubs = await getCoPublications("mentor01", "aoc1");

    expect(pubs).toEqual([]);
  });

  it("degrades to [] (no 500) when the bridge read throws", async () => {
    menteeCopubPubFindMany.mockRejectedValue(new Error("aurora down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const pubs = await getCoPublications("mentor01", "aoc1");

    expect(pubs).toEqual([]);
  });
});

describe("getCoPublications — live ReciterDB source, flag OFF", () => {
  beforeEach(() => {
    delete process.env.MENTORING_COPUB_BRIDGE;
  });

  it("builds the list from the article + author-list queries, then applies suppression", async () => {
    // Two ReciterDB round-trips: call 1 = article rows, call 2 = author-list.
    let call = 0;
    withReciterConnection.mockImplementation(
      async (fn: (conn: { query: () => Promise<unknown[]> }) => Promise<unknown>) => {
        return fn({
          query: async () => {
            call += 1;
            if (call === 1) {
              return [
                {
                  pmid: 111,
                  title: "Shared paper",
                  journal: "J. Test",
                  year: 2021,
                  doi: "10.1/x",
                  pmcid: null,
                  volume: "12",
                  issue: "3",
                  pages: "1-9",
                  citationCount: 7,
                  abstract: "An abstract.",
                },
              ];
            }
            return [
              { pmid: 111, rank: 1, authorLastName: "Mentor", authorFirstName: "Dr", personIdentifier: "mentor01" },
              { pmid: 111, rank: 2, authorLastName: "Student", authorFirstName: "Alex", personIdentifier: "aoc1" },
            ];
          },
        });
      },
    );

    const pubs = await getCoPublications("mentor01", "aoc1");

    expect(menteeCopubPubFindMany).not.toHaveBeenCalled();
    expect(pubs).toHaveLength(1);
    expect(pubs[0].pmid).toBe(111);
    expect(pubs[0].citationCount).toBe(7);
    expect(pubs[0].authors.map((a) => a.personIdentifier)).toEqual(["mentor01", "aoc1"]);
  });

  it("applies the same dark-pmid + author-hide suppression on the live path", async () => {
    withReciterConnection.mockImplementation(
      async (fn: (conn: { query: () => Promise<unknown[]> }) => Promise<unknown>) => {
        let call = 0;
        return fn({
          query: async () => {
            call += 1;
            if (call === 1) {
              return [
                { pmid: 111, title: "A", journal: null, year: 2021, doi: null, pmcid: null, volume: null, issue: null, pages: null, citationCount: 0, abstract: null },
                { pmid: 222, title: "B", journal: null, year: 2022, doi: null, pmcid: null, volume: null, issue: null, pages: null, citationCount: 0, abstract: null },
              ];
            }
            return [
              { pmid: 222, rank: 1, authorLastName: "Mentor", authorFirstName: "Dr", personIdentifier: "mentor01" },
              { pmid: 222, rank: 2, authorLastName: "Student", authorFirstName: "Alex", personIdentifier: "aoc1" },
            ];
          },
        });
      },
    );
    resolveDarkPmids.mockResolvedValue(new Set<string>(["111"])); // drop pmid 111
    isAuthorHidden.mockImplementation(
      (_s: unknown, pmid: string, cwid: string) => pmid === "222" && cwid === "aoc1",
    );

    const pubs = await getCoPublications("mentor01", "aoc1");

    expect(pubs.map((p) => p.pmid)).toEqual([222]);
    const ids = pubs[0].authors.map((a) => a.personIdentifier);
    expect(ids).toContain("mentor01");
    expect(ids).not.toContain("aoc1");
  });
});

describe("getCoPublications — guard clauses (both sources)", () => {
  it("returns [] for a missing or self-referential pair without touching either source", async () => {
    process.env.MENTORING_COPUB_BRIDGE = "on";
    expect(await getCoPublications("", "aoc1")).toEqual([]);
    expect(await getCoPublications("mentor01", "")).toEqual([]);
    expect(await getCoPublications("mentor01", "mentor01")).toEqual([]);
    expect(menteeCopubPubFindMany).not.toHaveBeenCalled();
    expect(withReciterConnection).not.toHaveBeenCalled();
  });
});
