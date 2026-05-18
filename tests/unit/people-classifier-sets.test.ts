/**
 * Issue #308 — unit tests for the People-tab classifier lookup-set cache.
 * Surnames come from an OpenSearch aggregation, departments from Prisma; both
 * are mocked here. Covers the build, the lowercasing, the TTL cache hit, and
 * graceful degradation on a failed refresh.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, osSearch } = vi.hoisted(() => ({
  findMany: vi.fn(),
  osSearch: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { scholar: { findMany } },
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
    osSearch.mockReset();
    vi.resetModules(); // fresh module-level cache per test
  });

  it("builds lowercased surname + department sets from OpenSearch and Prisma", async () => {
    osSearch.mockResolvedValue(osResponse(["Cantley", "WONG"]));
    findMany.mockResolvedValue([
      { primaryDepartment: "Cardiology" },
      { primaryDepartment: "Pediatrics" },
    ]);

    const { getPeopleClassifierSets } = await import(
      "@/lib/api/people-classifier-sets"
    );
    const sets = await getPeopleClassifierSets();

    expect([...sets.surnames].sort()).toEqual(["cantley", "wong"]);
    expect([...sets.departments].sort()).toEqual(["cardiology", "pediatrics"]);
  });

  it("caches — a second call within the TTL does not re-query", async () => {
    osSearch.mockResolvedValue(osResponse(["smith"]));
    findMany.mockResolvedValue([{ primaryDepartment: "Medicine" }]);

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
    findMany.mockResolvedValue([{ primaryDepartment: "Medicine" }]);

    const { getPeopleClassifierSets } = await import(
      "@/lib/api/people-classifier-sets"
    );
    const first = await getPeopleClassifierSets();
    expect(first.surnames.size).toBe(0);
    expect(first.departments.size).toBe(0);

    // The failure was not cached — a retry now succeeds.
    osSearch.mockResolvedValue(osResponse(["jones"]));
    const second = await getPeopleClassifierSets();
    expect([...second.surnames]).toEqual(["jones"]);
  });
});
