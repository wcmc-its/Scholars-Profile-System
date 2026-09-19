/**
 * `lib/edit/orcid-coverage.ts` — the pure fold behind `/edit/orcid-coverage`
 * (role grouping, the NIH-funded facet, null role → Unclassified, the
 * department outreach sort), the params parser, and the CSV. Synthetic cwids
 * and departments only (public repo).
 */
import { describe, expect, it } from "vitest";

import {
  buildOrcidCoverage,
  neither,
  nihNoOrcid,
  orcidCoverageCsv,
  orcidCoverageQuery,
  parseOrcidCoverageParams,
  type ScholarRow,
} from "@/lib/edit/orcid-coverage";

const TODAY = new Date("2026-09-18T00:00:00Z");
const s = (cwid: string, roleCategory: string | null, primaryDepartment: string | null, orcid = false): ScholarRow => ({
  cwid,
  roleCategory,
  primaryDepartment,
  orcid: orcid ? "0000-0002-1825-0097" : null,
});
const SCHOLARS: ScholarRow[] = [
  s("f1", "full_time_faculty", "Dept A", true),
  s("f2", "full_time_faculty", "Dept A"),
  s("f3", "full_time_faculty", "Dept B"),
  s("f4", "full_time_faculty", null),
  s("p1", "postdoc", "Dept A", true),
  s("u1", null, "Dept B"),
];
// f2 current NIH, f3 expired NIH, f4 current NIH, u1 expired NIH.
const NIH = [
  { cwid: "f2", latestEnd: new Date("2027-01-01T00:00:00Z") },
  { cwid: "f3", latestEnd: new Date("2020-01-01T00:00:00Z") },
  { cwid: "f4", latestEnd: new Date("2026-09-18T00:00:00Z") },
  { cwid: "u1", latestEnd: new Date("2021-01-01T00:00:00Z") },
];
const ERA = ["f1", "f3"];
const ALL = parseOrcidCoverageParams({ role: "all" });

describe("buildOrcidCoverage", () => {
  it("tiles are the unfiltered population regardless of filters", () => {
    const r = buildOrcidCoverage(SCHOLARS, NIH, ERA, parseOrcidCoverageParams({ nih: "none", dept: "Dept B" }), TODAY);
    expect(r.tiles.overall).toEqual({ people: 6, orcid: 2, era: 2, both: 1, nihPeople: 4, nihOrcid: 0 });
    expect(r.tiles.fullTime).toEqual({ people: 4, orcid: 1, era: 2, both: 1, nihPeople: 3, nihOrcid: 0 });
    expect(r.tiles.nihFullTime).toEqual({ people: 3, orcid: 0, era: 1, both: 0, nihPeople: 3, nihOrcid: 0 });
    expect(neither(r.tiles.overall)).toBe(3);
  });

  it("groups by role_category, null → Unclassified, people desc; ignores `role`", () => {
    const r = buildOrcidCoverage(SCHOLARS, NIH, ERA, parseOrcidCoverageParams({}), TODAY);
    expect(r.byRole.map((x) => [x.key, x.label, x.people])).toEqual([
      ["full_time_faculty", "Full-time faculty", 4],
      ["postdoc", "Postdoc", 1],
      [null, "Unclassified", 1],
    ]);
  });

  it("department table defaults to full-time faculty, sorted by NIH-funded-without-ORCID then people", () => {
    const r = buildOrcidCoverage(SCHOLARS, NIH, ERA, parseOrcidCoverageParams({}), TODAY);
    expect(r.params.role).toBe("full_time_faculty");
    // Dept A: f1 (orcid) + f2 (nih, no orcid) → 1; Dept B: f3 → 1; null: f4 → 1. Tie → people desc.
    expect(r.byDept.map((x) => [x.label, x.people, nihNoOrcid(x)])).toEqual([
      ["Dept A", 2, 1],
      ["Dept B", 1, 1],
      ["No department", 1, 1],
    ]);
    const all = buildOrcidCoverage(SCHOLARS, NIH, ERA, ALL, TODAY);
    expect(all.byDept.find((x) => x.label === "Dept B")?.people).toBe(2);
  });

  it("nih=ever / current / none partition on the grant end date", () => {
    const of = (nih: "ever" | "current" | "none") =>
      buildOrcidCoverage(SCHOLARS, NIH, ERA, parseOrcidCoverageParams({ role: "all", nih }), TODAY)
        .byRole.reduce((n, x) => n + x.people, 0);
    expect(of("ever")).toBe(4);
    expect(of("current")).toBe(2); // f2 (future) + f4 (ends today) — f3/u1 expired
    expect(of("none")).toBe(2);
  });

  it("dept filter narrows the person-type table only; role filter narrows the department table only", () => {
    const r = buildOrcidCoverage(SCHOLARS, NIH, ERA, parseOrcidCoverageParams({ role: "postdoc", dept: "Dept B" }), TODAY);
    expect(r.byRole.map((x) => [x.key, x.people])).toEqual([
      ["full_time_faculty", 1],
      [null, 1],
    ]);
    expect(r.byDept.map((x) => [x.label, x.people])).toEqual([["Dept A", 1]]);
  });

  it("select choices come from the data: roles by headcount (no null), departments A–Z", () => {
    const r = buildOrcidCoverage(SCHOLARS, NIH, ERA, ALL, TODAY);
    expect(r.roles).toEqual([
      ["full_time_faculty", "Full-time faculty"],
      ["postdoc", "Postdoc"],
    ]);
    expect(r.depts).toEqual(["Dept A", "Dept B"]);
  });
});

describe("parseOrcidCoverageParams / orcidCoverageQuery", () => {
  it("defaults: role=full_time_faculty, nih=all, dept=null; `all` clears; junk nih falls back", () => {
    expect(parseOrcidCoverageParams({})).toEqual({ role: "full_time_faculty", nih: "all", dept: null });
    expect(parseOrcidCoverageParams(new URLSearchParams("role=all&nih=junk&dept=all"))).toEqual({
      role: null,
      nih: "all",
      dept: null,
    });
    expect(parseOrcidCoverageParams({ role: ["postdoc", "x"], nih: "current", dept: " Dept A " })).toEqual({
      role: "postdoc",
      nih: "current",
      dept: "Dept A",
    });
  });

  it("round-trips through the query string", () => {
    expect(orcidCoverageQuery({ role: null, nih: "all" })).toBe("?role=all");
    expect(orcidCoverageQuery({ role: "postdoc", nih: "current", dept: "Dept A" })).toBe(
      "?role=postdoc&nih=current&dept=Dept+A",
    );
    expect(orcidCoverageQuery({})).toBe("");
    expect(parseOrcidCoverageParams(new URLSearchParams(orcidCoverageQuery({ role: null, nih: "none" })))).toEqual({
      role: null,
      nih: "none",
      dept: null,
    });
  });
});

describe("orcidCoverageCsv", () => {
  it("one aggregate row per department, derived columns computed, no per-person data", () => {
    const r = buildOrcidCoverage(SCHOLARS, NIH, ERA, ALL, TODAY);
    const csv = orcidCoverageCsv(r.byDept);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Department,People,ORCID iD on file,ORCID %,eRA profile on file,Both,Neither,NIH-funded,NIH-funded with ORCID,NIH-funded without ORCID",
    );
    expect(lines).toContain("Dept A,3,2,66.7,1,1,1,1,0,1");
    expect(lines).toHaveLength(1 + r.byDept.length);
    expect(csv).not.toMatch(/f1|0000-0002/);
  });
});
