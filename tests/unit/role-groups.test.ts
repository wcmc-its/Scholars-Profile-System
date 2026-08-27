/**
 * #2537 — `lib/role-groups.ts`: the ROLE_DISPLAY inversion that backs both the
 * client chip matcher (via `role-chip-row.tsx`) and the server `?type=` filter
 * (`lib/api/unit-members.ts`, `lib/api/centers.ts`).
 */
import { describe, expect, it } from "vitest";
import {
  FILTERABLE_ROLE_GROUPS,
  ROLE_CATEGORIES,
  ROLE_GROUPS,
  groupMatchesDisplay,
  groupToRawValues,
} from "@/lib/role-groups";

describe("ROLE_CATEGORIES / FILTERABLE_ROLE_GROUPS", () => {
  it("ROLE_CATEGORIES includes All plus the four filterable groups, in order", () => {
    expect(ROLE_CATEGORIES).toEqual([
      "All",
      "Full-time faculty",
      "Affiliated faculty",
      "Postdocs & non-faculty",
      "Doctoral students",
    ]);
  });

  it("FILTERABLE_ROLE_GROUPS excludes All", () => {
    expect(FILTERABLE_ROLE_GROUPS).not.toContain("All");
    expect(FILTERABLE_ROLE_GROUPS).toHaveLength(4);
  });
});

describe("groupToRawValues — ROLE_DISPLAY inversion", () => {
  it("All has no raw values (server cannot query-filter it)", () => {
    expect(groupToRawValues("All")).toEqual([]);
  });

  it("Full-time faculty inverts both DB casings", () => {
    const raws = groupToRawValues("Full-time faculty");
    expect(raws).toEqual(expect.arrayContaining(["FULL_TIME_FACULTY", "full_time_faculty"]));
  });

  it("Affiliated faculty includes Faculty emeritus's raws — EMERITUS and emeritus", () => {
    const raws = new Set(groupToRawValues("Affiliated faculty"));
    expect(raws.has("EMERITUS")).toBe(true);
    expect(raws.has("emeritus")).toBe(true);
    expect(raws.has("FACULTY_EMERITUS")).toBe(true);
    expect(raws.has("faculty_emeritus")).toBe(true);
    // And the rest of the fold-in.
    for (const raw of [
      "AFFILIATED_FACULTY",
      "affiliated_faculty",
      "VOLUNTARY_FACULTY",
      "voluntary_faculty",
      "ADJUNCT_FACULTY",
      "adjunct_faculty",
      "COURTESY_FACULTY",
      "courtesy_faculty",
    ]) {
      expect(raws.has(raw), `expected ${raw} in Affiliated faculty raws`).toBe(true);
    }
  });

  it("Postdocs & non-faculty folds in Postdoc/Fellow/Research staff/Instructor/Lecturer", () => {
    const raws = new Set(groupToRawValues("Postdocs & non-faculty"));
    for (const raw of [
      "POSTDOC",
      "postdoc",
      "FELLOW",
      "fellow",
      "RESEARCH_STAFF",
      "research_staff",
      "INSTRUCTOR",
      "instructor",
      "LECTURER",
      "lecturer",
    ]) {
      expect(raws.has(raw), `expected ${raw} in Postdocs & non-faculty raws`).toBe(true);
    }
  });

  it("Doctoral students is exact — DOES NOT include the MD/PhD/MD-PhD suffixed raws", () => {
    const raws = new Set(groupToRawValues("Doctoral students"));
    expect(raws.has("DOCTORAL_STUDENT")).toBe(true);
    expect(raws.has("doctoral_student")).toBe(true);
    expect(raws.has("DOCTORAL_STUDENT_MD")).toBe(false);
    expect(raws.has("DOCTORAL_STUDENT_PHD")).toBe(false);
    expect(raws.has("DOCTORAL_STUDENT_MDPHD")).toBe(false);
  });

  it("no two filterable groups share a raw value", () => {
    const seen = new Map<string, string>();
    for (const label of FILTERABLE_ROLE_GROUPS) {
      for (const raw of groupToRawValues(label)) {
        expect(seen.has(raw), `raw "${raw}" claimed by both "${seen.get(raw)}" and "${label}"`).toBe(
          false,
        );
        seen.set(raw, label);
      }
    }
  });
});

describe("groupMatchesDisplay — client-side counterpart", () => {
  it("All matches everything, including null", () => {
    expect(groupMatchesDisplay("All", null)).toBe(true);
    expect(groupMatchesDisplay("All", "Doctoral student")).toBe(true);
  });

  it("matches exactly the group's display labels, nothing else", () => {
    expect(groupMatchesDisplay("Full-time faculty", "Full-time faculty")).toBe(true);
    expect(groupMatchesDisplay("Full-time faculty", "Affiliated faculty")).toBe(false);
    expect(groupMatchesDisplay("Doctoral students", "MD student")).toBe(false);
  });

  it("ROLE_GROUPS shape matches role-chip-row.tsx verbatim (label + displayLabels count)", () => {
    const byLabel = new Map(ROLE_GROUPS.map((g) => [g.label, g.displayLabels.length]));
    expect(byLabel.get("All")).toBe(0);
    expect(byLabel.get("Full-time faculty")).toBe(1);
    expect(byLabel.get("Affiliated faculty")).toBe(5);
    expect(byLabel.get("Postdocs & non-faculty")).toBe(5);
    expect(byLabel.get("Doctoral students")).toBe(1);
  });
});
