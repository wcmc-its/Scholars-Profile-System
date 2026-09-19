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
  orcidTiers,
  parseOrcidCoverageParams,
  piNoEra,
  type CandidateRow,
  type ScholarRow,
} from "@/lib/edit/orcid-coverage";

const TODAY = new Date("2026-09-18T00:00:00Z");
const s = (
  cwid: string,
  roleCategory: string | null,
  primaryDepartment: string | null,
  orcid = false,
): ScholarRow => ({
  cwid,
  roleCategory,
  primaryDepartment,
  orcid: orcid ? "0000-0002-1825-0097" : null,
});
// Insertion order is deliberately ANTI-sorted (null role first, small departments
// before big ones, Dept B before Dept A) so every sort and tiebreak in the fold is
// load-bearing — a dropped sort must fail, not ride on Map insertion order.
const SCHOLARS: ScholarRow[] = [
  s("u1", null, "Dept B"),
  s("p1", "postdoc", "Dept B", true),
  s("p2", "postdoc", "Dept A"),
  s("f4", "full_time_faculty", null),
  s("f3", "full_time_faculty", "Dept B"),
  s("f1", "full_time_faculty", "Dept A", true),
  s("f2", "full_time_faculty", "Dept A", true),
  s("f5", "full_time_faculty", "Dept C"),
  s("f6", "full_time_faculty", "Dept C"),
];
// NIH: u1 + f3 expired, f4 ends today, f2 + f5 current. f2 is the one NIH-funded person WITH
// an ORCID. u1 + f4 are non-PI (Co-I) — NIH-funded but never resolvable from RePORTER.
const NIH = [
  { cwid: "u1", latestEnd: new Date("2021-01-01T00:00:00Z"), pi: false },
  { cwid: "f3", latestEnd: new Date("2020-01-01T00:00:00Z"), pi: true },
  { cwid: "f4", latestEnd: new Date("2026-09-18T00:00:00Z"), pi: false },
  { cwid: "f2", latestEnd: new Date("2027-01-01T00:00:00Z"), pi: true },
  { cwid: "f5", latestEnd: new Date("2028-01-01T00:00:00Z"), pi: true },
];
const ERA = ["f1", "f3"];
// RPM candidates: f3 strong; f4 thin; f5 two candidate iDs; u1 contradicted; f6 admin-entered
// (asserted); p1 already asserted via Identity so its inference must not double count.
const cand = (
  cwid: string,
  source: string,
  articlesAccepted = 0,
  articlesRejected = 0,
): CandidateRow => ({
  cwid,
  source,
  articlesAccepted,
  articlesRejected,
});
const CANDIDATES: CandidateRow[] = [
  cand("f3", "rpm_inferred", 5),
  cand("f4", "rpm_inferred", 1),
  cand("f5", "rpm_inferred", 10),
  cand("f5", "rpm_inferred", 4),
  cand("u1", "rpm_inferred", 3, 1),
  cand("f6", "rpm_admin"),
  cand("p1", "rpm_inferred", 20),
];
const ALL = parseOrcidCoverageParams({ role: "all" });
const build = (params = ALL) => buildOrcidCoverage(SCHOLARS, NIH, ERA, params, TODAY, CANDIDATES);

describe("orcidTiers", () => {
  it("admin beats inferred; strong needs one candidate, ≥3 accepted, 0 rejected; everything else inferred is weak", () => {
    const t = orcidTiers([
      ...CANDIDATES,
      cand("x1", "rpm_inferred", 3),
      cand("x2", "rpm_inferred", 2),
      cand("x3", "rpm_inferred", 30, 1),
      cand("x4", "rpm_admin"),
      cand("x4", "rpm_inferred", 1, 5),
    ]);
    expect([...t]).toEqual(
      expect.arrayContaining([
        ["f3", "strong"],
        ["f4", "weak"],
        ["f5", "weak"],
        ["u1", "weak"],
        ["f6", "asserted"],
        ["x1", "strong"],
        ["x2", "weak"],
        ["x3", "weak"],
        ["x4", "asserted"],
      ]),
    );
    expect(t.has("p2")).toBe(false);
  });
});

describe("buildOrcidCoverage", () => {
  it("tiles are the unfiltered population regardless of filters", () => {
    const r = build(parseOrcidCoverageParams({ nih: "none", dept: "Dept B" }));
    // Asserted: p1/f1/f2 (Identity) + f6 (admin). Strong: f3. Weak: f4, f5, u1. None: p2.
    const c = {
      people: 9,
      orcid: 4,
      strong: 1,
      weak: 3,
      era: 2,
      both: 1,
      nihPeople: 5,
      nihOrcid: 1,
      nihStrong: 1,
      nihPi: 3,
      nihPiEra: 1,
    };
    expect(r.tiles.overall).toEqual(c);
    expect(r.tiles.fullTime).toEqual({ ...c, people: 6, orcid: 3, weak: 2, nihPeople: 4 });
    expect(r.tiles.nihFullTime).toEqual({
      ...c,
      people: 4,
      orcid: 1,
      weak: 2,
      era: 1,
      both: 0,
      nihPeople: 4,
    });
    expect(neither(r.tiles.overall)).toBe(4);
    expect(nihNoOrcid(r.tiles.nihFullTime)).toBe(3);
    // f2 + f5 are PIs without an eRA row; u1/f4 are Co-Is and do NOT count as a resolver gap.
    expect(piNoEra(r.tiles.overall)).toBe(2);
  });

  it("groups by role_category, null → Unclassified, people desc; ignores `role`", () => {
    const r = build(parseOrcidCoverageParams({}));
    expect(r.byRole.map((x) => [x.key, x.label, x.people])).toEqual([
      ["full_time_faculty", "Full-time faculty", 6],
      ["postdoc", "Postdoc", 2],
      [null, "Unclassified", 1],
    ]);
  });

  it("department table defaults to full-time faculty, sorted by NIH-funded-without-ORCID, then people, then label", () => {
    const r = build(parseOrcidCoverageParams({}));
    expect(r.params.role).toBe("full_time_faculty");
    expect(r.byDept.map((x) => [x.label, x.people, nihNoOrcid(x)])).toEqual([
      ["Dept C", 2, 1],
      ["Dept B", 1, 1],
      ["No department", 1, 1],
      ["Dept A", 2, 0],
    ]);
    const all = build();
    expect(all.byDept.find((x) => x.label === "Dept B")?.people).toBe(3);
  });

  it("nih=ever / current / none partition on the grant end date", () => {
    const of = (nih: "ever" | "current" | "none") =>
      build(parseOrcidCoverageParams({ role: "all", nih })).byRole.reduce(
        (n, x) => n + x.people,
        0,
      );
    expect(of("ever")).toBe(5);
    expect(of("current")).toBe(3); // f4 (ends today) + f2 + f5 — u1/f3 expired
    expect(of("none")).toBe(4);
  });

  it("dept filter narrows the person-type table only; role filter narrows the department table only", () => {
    const r = build(parseOrcidCoverageParams({ role: "postdoc", dept: "Dept B" }));
    expect(r.byRole.map((x) => [x.key, x.people])).toEqual([
      ["full_time_faculty", 1],
      ["postdoc", 1],
      [null, 1],
    ]);
    expect(r.byDept.map((x) => [x.label, x.people])).toEqual([
      ["Dept A", 1],
      ["Dept B", 1],
    ]);
  });

  it("select choices come from the data: roles by headcount (no null), departments A–Z", () => {
    const r = build();
    expect(r.roles).toEqual([
      ["full_time_faculty", "Full-time faculty"],
      ["postdoc", "Postdoc"],
    ]);
    expect(r.depts).toEqual(["Dept A", "Dept B", "Dept C"]);
  });
});

describe("parseOrcidCoverageParams / orcidCoverageQuery", () => {
  it("defaults: role=full_time_faculty, nih=all, dept=null; `all` clears; junk nih falls back", () => {
    expect(parseOrcidCoverageParams({})).toEqual({
      role: "full_time_faculty",
      nih: "all",
      dept: null,
    });
    expect(parseOrcidCoverageParams(new URLSearchParams("role=all&nih=junk&dept=all"))).toEqual({
      role: null,
      nih: "all",
      dept: null,
    });
    expect(
      parseOrcidCoverageParams({ role: ["postdoc", "x"], nih: "current", dept: " Dept A " }),
    ).toEqual({
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
    expect(
      parseOrcidCoverageParams(
        new URLSearchParams(orcidCoverageQuery({ role: null, nih: "none" })),
      ),
    ).toEqual({
      role: null,
      nih: "none",
      dept: null,
    });
  });
});

describe("orcidCoverageCsv", () => {
  it("one aggregate row per department, derived columns computed, no per-person data", () => {
    const r = build();
    const csv = orcidCoverageCsv(r.byDept);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Department,People,Asserted ORCID,Asserted %,Inferred ORCID (strong),Inferred ORCID (weak),eRA account (inferred),Both,Neither,NIH-funded,NIH-funded with asserted ORCID,NIH-funded without asserted ORCID,NIH-funded without asserted but strong inference,NIH PI,NIH PI without eRA account",
    );
    expect(lines).toContain("Dept A,3,2,66.7,0,0,1,1,1,1,1,0,0,1,1");
    // Dept B: u1 is a Co-I (not a PI) so its missing eRA row is not a gap; f3 is a PI with one
    // and a strong inference; p1's inference doesn't count — Identity already asserts it.
    expect(lines).toContain("Dept B,3,1,33.3,1,1,1,0,1,2,0,2,1,1,0");
    expect(lines).toHaveLength(1 + r.byDept.length);
    expect(csv).not.toMatch(/f1|p1|0000-0002/);
  });
});
