/**
 * #1760 — profile ordering for `honor` rows.
 *
 * Covers the render contract the "Honors & Distinctions" section relies on: one
 * flat list, year DESC, unknown years last, and `[]` for `[]` so the section can
 * omit itself.
 *
 * Category grouping was REMOVED (2026-07-16): the row already names its
 * conferring body, so an "Academy memberships" heading over "National Academy of
 * Medicine" only restated it. `category` still drives /edit and the Phase 3
 * roster feed, so it stays on `HonorEntry` — it just never reaches the profile.
 * The test that category does NOT influence order is what pins that.
 *
 * The visibility gate is deliberately NOT tested here — `sortHonors` cannot see
 * `status`/`showOnProfile`, because the loader query drops non-published/hidden
 * rows before they ever reach the payload. That gate is pinned in
 * `profile-api.test.ts`, at the query where it actually lives.
 */
import { describe, expect, it } from "vitest";

import { sortHonors, type HonorEntry } from "@/lib/api/profile";

function honor(overrides: Partial<HonorEntry>): HonorEntry {
  return {
    category: "ACADEMY_MEMBERSHIP",
    name: "Member",
    organization: "National Academy of Medicine",
    year: 2019,
    ...overrides,
  };
}

describe("sortHonors — year ordering", () => {
  it("orders rows by year descending", () => {
    const rows = [
      honor({ name: "Middle", year: 2015 }),
      honor({ name: "Oldest", year: 2001 }),
      honor({ name: "Newest", year: 2024 }),
    ];

    expect(sortHonors(rows).map((h) => h.name)).toEqual(["Newest", "Middle", "Oldest"]);
  });

  it("sorts unknown years last rather than treating null as year zero", () => {
    const rows = [
      honor({ name: "Unknown year", year: null }),
      honor({ name: "Known 2024", year: 2024 }),
      honor({ name: "Known 2001", year: 2001 }),
    ];

    expect(sortHonors(rows).map((h) => h.name)).toEqual([
      "Known 2024",
      "Known 2001",
      "Unknown year",
    ]);
  });

  it("keeps the loader's order for rows sharing a year, and for all-null years", () => {
    const sameYear = [honor({ name: "Alpha", year: 2020 }), honor({ name: "Beta", year: 2020 })];
    expect(sortHonors(sameYear).map((h) => h.name)).toEqual(["Alpha", "Beta"]);

    const noYears = [honor({ name: "Alpha", year: null }), honor({ name: "Beta", year: null })];
    expect(sortHonors(noYears).map((h) => h.name)).toEqual(["Alpha", "Beta"]);
  });

  it("returns no rows for empty input, so the section omits itself", () => {
    expect(sortHonors([])).toEqual([]);
  });
});

describe("sortHonors — category does not reach the render", () => {
  it("interleaves categories purely by year, never grouping them", () => {
    const rows = [
      honor({ category: "ACADEMY_MEMBERSHIP", name: "Academy 2005", year: 2005 }),
      honor({ category: "PRIZE", name: "Prize 2010", year: 2010 }),
      honor({ category: "ACADEMY_MEMBERSHIP", name: "Academy 2020", year: 2020 }),
      honor({ category: "PRIZE", name: "Prize 2022", year: 2022 }),
    ];

    // Grouped output would be ["Academy 2020","Academy 2005","Prize 2022","Prize 2010"].
    // A flat year sort interleaves them — that difference IS the contract.
    expect(sortHonors(rows).map((h) => h.name)).toEqual([
      "Prize 2022",
      "Academy 2020",
      "Prize 2010",
      "Academy 2005",
    ]);
  });

  it("keeps every row — nothing is filtered by category", () => {
    const rows = [
      honor({ category: "OTHER", name: "Other honor", year: 2003 }),
      honor({ category: "PRIZE", name: "Lasker Award", year: 2004 }),
      honor({ category: "ACADEMY_MEMBERSHIP", name: "Member", year: 2005 }),
      honor({ category: "INVESTIGATORSHIP", name: "Investigator", year: 2006 }),
    ];

    expect(sortHonors(rows)).toHaveLength(rows.length);
  });
});

describe("sortHonors — purity", () => {
  it("does not mutate the caller's array", () => {
    // Load-bearing: `sort` is in-place, and this helper no longer gets a free
    // copy from a `filter` the way the old grouping version did. If the spread
    // in `sortHonors` is ever dropped, this is the test that fails.
    const rows = [honor({ name: "Old", year: 2001 }), honor({ name: "New", year: 2024 })];

    sortHonors(rows);

    expect(rows.map((h) => h.name)).toEqual(["Old", "New"]);
  });
});
