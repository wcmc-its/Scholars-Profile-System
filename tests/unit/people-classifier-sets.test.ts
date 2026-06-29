/**
 * Issue #308 — unit tests for the People-tab classifier lookup-set cache.
 * Surnames come from an OpenSearch aggregation; cwids and departments from
 * Prisma; all are mocked here. Covers the build, the lowercasing, the TTL
 * cache hit, and graceful degradation on a failed refresh.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, divisionFindMany, osSearch } = vi.hoisted(() => ({
  findMany: vi.fn(),
  divisionFindMany: vi.fn(),
  osSearch: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { scholar: { findMany }, division: { findMany: divisionFindMany } },
}));

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  searchClient: () => ({ search: osSearch }),
}));

/** Shape an OpenSearch terms-aggregation response for the given surname keys. */
function osResponse(surnames: string[]) {
  return {
    body: {
      aggregations: {
        surnames: {
          buckets: surnames.map((s) => ({ key: s, doc_count: 1 })),
        },
      },
    },
  };
}

describe("getPeopleClassifierSets", () => {
  beforeEach(() => {
    findMany.mockReset();
    divisionFindMany.mockReset().mockResolvedValue([]); // #1347 — default: no divisions
    osSearch.mockReset();
    vi.resetModules(); // fresh module-level cache per test
  });

  it("builds lowercased surname, cwid, and department sets", async () => {
    osSearch.mockResolvedValue(osResponse(["Cantley", "WONG"]));
    findMany.mockResolvedValue([
      { cwid: "abc1001", primaryDepartment: "Cardiology" },
      { cwid: "def2002", primaryDepartment: "Pediatrics" },
    ]);

    const { getPeopleClassifierSets } = await import(
      "@/lib/api/people-classifier-sets"
    );
    const sets = await getPeopleClassifierSets();

    expect([...sets.surnames].sort()).toEqual(["cantley", "wong"]);
    expect([...sets.cwids].sort()).toEqual(["abc1001", "def2002"]);
    expect([...sets.departments].sort()).toEqual(["cardiology", "pediatrics"]);
  });

  it("#1347 — builds the lowercased division-name → deptDivKey(s) map", async () => {
    osSearch.mockResolvedValue(osResponse(["smith"]));
    findMany.mockResolvedValue([{ cwid: "abc1001", primaryDepartment: "Medicine" }]);
    divisionFindMany.mockResolvedValue([
      { name: "Hematology", code: "HEM", deptCode: "MED" },
      { name: "Cardiology", code: "CARD", deptCode: "MED" },
      // Same name across two departments → both roster keys under one entry.
      { name: "Cardiology", code: "CARD", deptCode: "PEDS" },
    ]);

    const { getPeopleClassifierSets } = await import(
      "@/lib/api/people-classifier-sets"
    );
    const sets = await getPeopleClassifierSets();

    expect(sets.divisions.get("hematology")).toEqual(["MED--HEM"]);
    expect(sets.divisions.get("cardiology")).toEqual(["MED--CARD", "PEDS--CARD"]);
  });

  it("caches — a second call within the TTL does not re-query", async () => {
    osSearch.mockResolvedValue(osResponse(["smith"]));
    findMany.mockResolvedValue([
      { cwid: "ghi3003", primaryDepartment: "Medicine" },
    ]);

    const { getPeopleClassifierSets } = await import(
      "@/lib/api/people-classifier-sets"
    );
    await getPeopleClassifierSets();
    await getPeopleClassifierSets();

    expect(osSearch).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("degrades to empty sets on a failed refresh, and does not cache the failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    osSearch.mockRejectedValueOnce(new Error("scholars-people index missing"));
    findMany.mockResolvedValue([
      { cwid: "jkl4004", primaryDepartment: "Medicine" },
    ]);

    const { getPeopleClassifierSets } = await import(
      "@/lib/api/people-classifier-sets"
    );
    const first = await getPeopleClassifierSets();
    expect(first.surnames.size).toBe(0);
    expect(first.cwids.size).toBe(0);
    expect(first.departments.size).toBe(0);

    // The failure was not cached — a retry now succeeds.
    osSearch.mockResolvedValue(osResponse(["jones"]));
    const second = await getPeopleClassifierSets();
    expect([...second.surnames]).toEqual(["jones"]);
  });

  // Issue #610 — a wedged refresh (a Prisma pool / OpenSearch connection that
  // never settles) must not hang the People search. Without the timeout the
  // memoized `inflight` promise never resolves, so every subsequent request
  // returns that same pending promise until the process restarts.
  it("times out a wedged refresh, degrading to empty sets without hanging", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      // findMany never settles — the failure mode the issue describes.
      findMany.mockReturnValue(new Promise(() => {}));
      osSearch.mockResolvedValue(osResponse(["smith"]));

      const { getPeopleClassifierSets } = await import(
        "@/lib/api/people-classifier-sets"
      );
      const pending = getPeopleClassifierSets();
      // Trip the 2s ceiling; the request resolves rather than hanging forever.
      await vi.advanceTimersByTimeAsync(2000);
      const sets = await pending;
      expect(sets.surnames.size).toBe(0);
      expect(sets.cwids.size).toBe(0);
      expect(sets.departments.size).toBe(0);

      // The timeout was not cached — once the backend recovers, a retry
      // rebuilds the real sets.
      findMany.mockResolvedValue([
        { cwid: "mno5005", primaryDepartment: "Surgery" },
      ]);
      const recovered = await getPeopleClassifierSets();
      expect([...recovered.cwids]).toEqual(["mno5005"]);
      expect([...recovered.departments]).toEqual(["surgery"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
