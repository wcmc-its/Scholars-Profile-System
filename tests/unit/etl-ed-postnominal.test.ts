/**
 * #2206 — faculty postnominal degrees. The people-branch search returned no
 * `weillCornellEduDegree` for faculty in prod (0/7,721), so the ED ETL now
 * falls back to the faculty SOR parent record's degree, the same SOR-parent
 * source doctoral students already get theirs from.
 *
 * Pure-logic test with synthetic data: the ED ETL's `main()` is guarded by
 * `!process.env.VITEST`, so importing the module here runs no sync.
 */
import { describe, expect, it } from "vitest";

import { resolvePostnominal } from "@/etl/ed/index";
import { collectSorDegrees, DEFAULT_FACULTY_SOR_PERSON_FILTER } from "@/lib/sources/ldap";

describe("resolvePostnominal (#2206)", () => {
  it("falls back to the faculty SOR degree when the entry has none", () => {
    expect(resolvePostnominal(null, "MD, PhD")).toBe("MD, PhD");
    expect(resolvePostnominal(undefined, " MD ")).toBe("MD");
    expect(resolvePostnominal("   ", "DO")).toBe("DO");
  });

  it("prefers the entry's own degree when present", () => {
    expect(resolvePostnominal("PhD", "MD")).toBe("PhD");
  });

  it("is null when neither source has a non-blank degree", () => {
    expect(resolvePostnominal(null, undefined)).toBeNull();
    expect(resolvePostnominal("", "  ")).toBeNull();
  });
});

describe("collectSorDegrees (#2206)", () => {
  it("maps cwid to the trimmed degree, skipping blanks and missing cwids", () => {
    const m = collectSorDegrees([
      { weillCornellEduCWID: "aaa0001", weillCornellEduDegree: ["MD "] },
      { weillCornellEduCWID: "aaa0002", weillCornellEduDegree: "MB,BS" },
      { weillCornellEduCWID: "aaa0003", weillCornellEduDegree: "  " },
      { weillCornellEduCWID: "aaa0004" },
      { weillCornellEduDegree: "PhD" },
      { weillCornellEduCWID: "aaa0001", weillCornellEduDegree: "PhD" },
    ]);
    expect([...m.entries()]).toEqual([
      ["aaa0001", "MD"],
      ["aaa0002", "MB,BS"],
    ]);
  });

  it("searches the SOR parent records, not the Role subordinates", () => {
    expect(DEFAULT_FACULTY_SOR_PERSON_FILTER).toContain("objectClass=weillCornellEduSORRecord");
    expect(DEFAULT_FACULTY_SOR_PERSON_FILTER).toContain("weillCornellEduStatus=faculty:active");
  });
});
