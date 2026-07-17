/**
 * #1760 — profile grouping for `honor` rows.
 *
 * Covers the render contract the "Honors & Distinctions" section relies on:
 * groups in `HonorCategory` ENUM order (not alphabetical, not input order), rows
 * within a group by year DESC with unknown years last, and empty groups dropped
 * so the section can omit itself.
 *
 * The visibility gate is deliberately NOT tested here — `groupHonors` cannot see
 * `status`/`showOnProfile`, because the loader query drops non-published/hidden
 * rows before they ever reach the payload. That gate is pinned in
 * `profile-api.test.ts`, at the query where it actually lives.
 */
import { describe, expect, it } from "vitest";

import { groupHonors, type HonorEntry } from "@/lib/api/profile";

function honor(overrides: Partial<HonorEntry>): HonorEntry {
  return {
    category: "ACADEMY_MEMBERSHIP",
    name: "Member",
    organization: "National Academy of Medicine",
    year: 2019,
    ...overrides,
  };
}

describe("groupHonors — category grouping", () => {
  it("returns groups in HonorCategory enum order regardless of input order", () => {
    const rows = [
      honor({ category: "OTHER", name: "Other honor" }),
      honor({ category: "PRIZE", name: "Lasker Award" }),
      honor({ category: "ACADEMY_MEMBERSHIP", name: "Member" }),
      honor({ category: "INVESTIGATORSHIP", name: "Investigator" }),
    ];

    expect(groupHonors(rows).map((g) => g.category)).toEqual([
      "ACADEMY_MEMBERSHIP",
      "INVESTIGATORSHIP",
      "PRIZE",
      "OTHER",
    ]);
  });

  it("puts every row in exactly one group, partitioning the input", () => {
    const rows = [
      honor({ category: "ACADEMY_MEMBERSHIP", name: "Member" }),
      honor({ category: "ACADEMY_MEMBERSHIP", name: "Fellow" }),
      honor({ category: "PRIZE", name: "Lasker Award" }),
    ];

    const grouped = groupHonors(rows);
    const total = grouped.reduce((sum, g) => sum + g.entries.length, 0);

    expect(total).toBe(rows.length);
    expect(grouped.map((g) => g.entries.map((h) => h.name))).toEqual([
      ["Member", "Fellow"],
      ["Lasker Award"],
    ]);
  });

  it("drops empty groups so a category with no rows renders no heading", () => {
    const grouped = groupHonors([honor({ category: "PRIZE", name: "Lasker Award" })]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].category).toBe("PRIZE");
  });

  it("returns no groups for empty input, so the section omits itself", () => {
    expect(groupHonors([])).toEqual([]);
  });
});

describe("groupHonors — year ordering", () => {
  it("orders rows within a group by year descending", () => {
    const rows = [
      honor({ name: "Middle", year: 2015 }),
      honor({ name: "Oldest", year: 2001 }),
      honor({ name: "Newest", year: 2024 }),
    ];

    expect(groupHonors(rows)[0].entries.map((h) => h.name)).toEqual([
      "Newest",
      "Middle",
      "Oldest",
    ]);
  });

  it("sorts unknown years last rather than treating null as year zero", () => {
    const rows = [
      honor({ name: "Unknown year", year: null }),
      honor({ name: "Known 2024", year: 2024 }),
      honor({ name: "Known 2001", year: 2001 }),
    ];

    expect(groupHonors(rows)[0].entries.map((h) => h.name)).toEqual([
      "Known 2024",
      "Known 2001",
      "Unknown year",
    ]);
  });

  it("keeps the loader's order for rows sharing a year, and for all-null years", () => {
    const sameYear = [
      honor({ name: "Alpha", year: 2020 }),
      honor({ name: "Beta", year: 2020 }),
    ];
    expect(groupHonors(sameYear)[0].entries.map((h) => h.name)).toEqual(["Alpha", "Beta"]);

    const noYears = [honor({ name: "Alpha", year: null }), honor({ name: "Beta", year: null })];
    expect(groupHonors(noYears)[0].entries.map((h) => h.name)).toEqual(["Alpha", "Beta"]);
  });

  it("orders each group independently", () => {
    const rows = [
      honor({ category: "ACADEMY_MEMBERSHIP", name: "Academy 2005", year: 2005 }),
      honor({ category: "PRIZE", name: "Prize 2010", year: 2010 }),
      honor({ category: "ACADEMY_MEMBERSHIP", name: "Academy 2020", year: 2020 }),
      honor({ category: "PRIZE", name: "Prize 2022", year: 2022 }),
    ];

    expect(groupHonors(rows).map((g) => g.entries.map((h) => h.name))).toEqual([
      ["Academy 2020", "Academy 2005"],
      ["Prize 2022", "Prize 2010"],
    ]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [honor({ name: "Old", year: 2001 }), honor({ name: "New", year: 2024 })];

    groupHonors(rows);

    expect(rows.map((h) => h.name)).toEqual(["Old", "New"]);
  });
});
