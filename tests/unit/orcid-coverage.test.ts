/**
 * `lib/edit/orcid-coverage.ts` — the pure fold behind `/edit/orcid-coverage`
 * (role grouping, the NIH-funded facet, null role → Unclassified, the
 * department outreach sort), the params parser, and the CSV. Synthetic cwids
 * and departments only (public repo).
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildOrcidCoverage,
  inferenceSourceCounts,
  loadOrcidCoverage,
  openAuthorshipImpact,
  CSV_WAITING_HEADER,
  OPEN_AUTHORSHIP_MAX_AGE_HOURS,
  neither,
  nihNoOrcid,
  orcidCoverageCriteria,
  orcidCoverageCsv,
  orcidCoverageExportCsv,
  orcidCoverageFilename,
  orcidCoverageActiveFilters,
  orcidCoverageQuery,
  orcidTiers,
  orcidVerdict,
  parseOrcidCoverageParams,
  SUGGEST_MIN_ACCEPTED,
  piNoEra,
  withoutDismissed,
  type CandidateRow,
  type OrcidCoverageClient,
  type ScholarRow,
} from "@/lib/edit/orcid-coverage";

const TODAY = new Date("2026-09-18T00:00:00Z");
const s = (
  cwid: string,
  roleCategory: string | null,
  primaryDepartment: string | null,
  orcid = false,
  confirmed = false,
): ScholarRow => ({
  cwid,
  roleCategory,
  primaryDepartment,
  orcid: orcid ? "0000-0002-1825-0097" : null,
  orcidConfirmedAt: confirmed ? new Date("2026-09-20T00:00:00Z") : null,
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
  s("f2", "full_time_faculty", "Dept A", true, true),
  s("f5", "full_time_faculty", "Dept C"),
  s("f6", "full_time_faculty", "Dept C"),
];
// f2 is the one CONFIRMED iD (in /edit); p1 + f1 hold theirs from Identity, so a fold that
// ignored `orcidConfirmedAt` would count 3 confirmed where there is 1.
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
// Candidate iDs are opaque tokens ("iD-a", "iD-b"), never real ORCIDs. `(cwid, orcid, source)`
// is the table's PK: two rows for one cwid carry different tokens OR different sources (the
// RPM mirror and the registry mirror writing the same iD — the agreement case). Every
// fixture below is checked against that key so no test feeds a state the table cannot hold.
const pkValid = (rows: CandidateRow[]) =>
  new Set(rows.map((r) => `${r.cwid}|${r.orcid}|${r.source}`)).size === rows.length;
const cand = (
  cwid: string,
  source: string,
  articlesAccepted = 0,
  articlesRejected = 0,
  orcid = "iD-a",
): CandidateRow => ({
  cwid,
  orcid,
  source,
  articlesAccepted,
  articlesRejected,
});
const CANDIDATES: CandidateRow[] = [
  cand("f3", "rpm_inferred", 5),
  cand("f4", "rpm_inferred", 1),
  cand("f5", "rpm_inferred", 10),
  cand("f5", "rpm_inferred", 4, 0, "iD-b"),
  cand("u1", "rpm_inferred", 3, 1),
  cand("f6", "rpm_admin"),
  cand("p1", "rpm_inferred", 20),
];
const ALL = parseOrcidCoverageParams({ role: "all" });
const build = (params = ALL) => buildOrcidCoverage(SCHOLARS, NIH, ERA, params, TODAY, CANDIDATES);

describe("orcidTiers", () => {
  it("an admin iD is a strong candidate, never asserted; strong inferred needs one candidate, ≥3 accepted, 0 rejected; everything else inferred is weak", () => {
    const rows = [
      ...CANDIDATES,
      cand("x1", "rpm_inferred", 3),
      cand("x2", "rpm_inferred", 2),
      cand("x3", "rpm_inferred", 30, 1),
      cand("x4", "rpm_admin"),
      cand("x4", "rpm_inferred", 1, 5, "iD-b"),
    ];
    expect(pkValid(rows)).toBe(true);
    const t = orcidTiers(rows);
    expect([...t]).toEqual(
      expect.arrayContaining([
        ["f3", "strong"],
        ["f4", "weak"],
        ["f5", "weak"],
        ["u1", "weak"],
        ["f6", "strong"],
        ["x1", "strong"],
        ["x2", "weak"],
        ["x3", "weak"],
        // The admin iD is strong; the inferred iD with rejections is not eligible, so no rival.
        ["x4", "strong"],
      ]),
    );
    expect(t.has("p2")).toBe(false);
  });

  // Registry-derived rows (etl/orcid-registry): orcid_email and orcid_works (≥3 shared works)
  // are strong on their own, orcid_name is only ever weak, and the fold re-checks the works
  // threshold rather than trusting the ETL's. Rows are listed weak-before-strong and
  // registry-before-RPM within a cwid so nothing rides on row order.
  it("registry rows: email or ≥3 shared works → strong; name-only or under-threshold works → weak", () => {
    const rows = [
      // orcid_name carrying ≥3 is the sweep's AMBIGUOUS case (another scholar shares ≥3
      // with the same iD) — the count must not promote it.
      cand("r7", "orcid_name", 5),
      cand("r4", "orcid_name", 2),
      cand("r3", "orcid_works", 2),
      cand("r2", "orcid_works", 3),
      cand("r1", "orcid_email"),
      // Two different registry iDs, each strong on its own — the person has two candidates,
      // which is exactly the ambiguity "strong" must not paper over.
      cand("r5", "orcid_works", 4, 0, "iD-b"),
      cand("r5", "orcid_works", 3),
      // A registry name match next to a strong sole RPM inference on a DIFFERENT iD: the
      // second candidate is not strong-eligible, so it does not demote (the page copy says
      // "two or more STRONG candidate ORCIDs", not "several candidates").
      cand("r6", "orcid_name", 1, 0, "iD-b"),
      cand("r6", "rpm_inferred", 5),
    ];
    expect(pkValid(rows)).toBe(true);
    const t = orcidTiers(rows);
    expect([...t]).toEqual(
      expect.arrayContaining([
        ["r1", "strong"],
        ["r2", "strong"],
        ["r3", "weak"],
        ["r4", "weak"],
        ["r5", "weak"],
        ["r6", "strong"],
        ["r7", "weak"],
      ]),
    );
    expect(t.size).toBe(7);
  });

  it("the RPM rule is unchanged: a second rpm_inferred iD demotes even a well-supported first one", () => {
    const t = orcidTiers([
      cand("m1", "rpm_inferred", 1, 0, "iD-b"),
      cand("m1", "rpm_inferred", 10),
    ]);
    expect(t.get("m1")).toBe("weak");
  });

  it("RPM and the registry agreeing on one iD is strong whatever the accepted counts — unless the RPM row has rejections; disagreeing is weak, an admin iD included", () => {
    // a1 is two rows on the SAME token under different sources — legal only because `source`
    // is in the PK; the RPM nightly and the registry weekly never overwrite each other.
    // a4: the RPM side saw the iD on articles the person REJECTED (a homonym's iD), and a
    // name-only registry hit on that iD is the same homonym — not a second witness.
    const rows = [
      cand("a4", "orcid_name", 0),
      cand("a4", "rpm_inferred", 1, 2),
      cand("a3", "orcid_email", 0, 0, "iD-b"),
      cand("a3", "rpm_admin"),
      cand("a2", "orcid_name", 0, 0, "iD-b"),
      cand("a2", "rpm_inferred", 1),
      cand("a1", "orcid_name", 0),
      cand("a1", "rpm_inferred", 1),
    ];
    expect(pkValid(rows)).toBe(true);
    const t = orcidTiers(rows);
    expect([...t]).toEqual(
      expect.arrayContaining([
        ["a1", "strong"],
        ["a2", "weak"],
        // An admin iD and an email-verified registry iD disagree: two strong iDs, so weak.
        ["a3", "weak"],
        ["a4", "weak"],
      ]),
    );
    expect(t.size).toBe(4);
  });
});

describe("buildOrcidCoverage", () => {
  it("tiles are the unfiltered population regardless of filters", () => {
    const r = build(parseOrcidCoverageParams({ nih: "none", dept: "Dept B" }));
    // Asserted: p1/f1 (Identity) + f2 (confirmed). Strong: f3 + f6 (an admin iD is a
    // candidate). Weak: f4, f5, u1. None: p2.
    const c = {
      people: 9,
      orcid: 3,
      confirmed: 1,
      strong: 2,
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
    expect(r.tiles.fullTime).toEqual({ ...c, people: 6, orcid: 2, weak: 2, nihPeople: 4 });
    // f2, the confirmed one, is full-time AND NIH-funded, so every tile carries it.
    expect(r.tiles.nihFullTime).toEqual({
      ...c,
      people: 4,
      orcid: 1,
      strong: 1,
      weak: 2,
      era: 1,
      both: 0,
      nihPeople: 4,
    });
    expect(neither(r.tiles.overall)).toBe(5);
    expect(nihNoOrcid(r.tiles.nihFullTime)).toBe(3);
    // f2 + f5 are PIs without an eRA row; u1/f4 are Co-Is and do NOT count as a resolver gap.
    expect(piNoEra(r.tiles.overall)).toBe(2);
  });

  it("dismissed (cwid, iD) pairs count nowhere: not as a candidate row, not as scholar.orcid — and only that exact pair", () => {
    // Listed f6 → f2 (anti-sorted). f6's admin iD-a (a strong candidate) is dismissed, but f3's iD-a (another cwid,
    // same token) must survive; f5 dismissed its SECOND candidate, which leaves the first one
    // sole and strong; f2 dismissed the iD on its own scholar row (the contradiction
    // etl:orcid-push also refuses), so it is neither asserted nor confirmed.
    const dismissals = [
      { cwid: "f6", orcid: "iD-a" },
      { cwid: "f5", orcid: "iD-b" },
      { cwid: "f2", orcid: "0000-0002-1825-0097" },
    ];
    const r = buildOrcidCoverage(SCHOLARS, NIH, ERA, ALL, TODAY, CANDIDATES, dismissals);
    expect(r.tiles.overall).toMatchObject({ people: 9, orcid: 2, confirmed: 0, strong: 2, weak: 2 });
    // Without the dismissals the same rows are 3 asserted / 1 confirmed / 2 strong / 3 weak.
    expect(build().tiles.overall).toMatchObject({ orcid: 3, confirmed: 1, strong: 2, weak: 3 });
  });

  it("groups by role_category, null → Unclassified, people desc; ignores `type`", () => {
    const r = build(parseOrcidCoverageParams({}));
    expect(r.byRole.map((x) => [x.key, x.label, x.people])).toEqual([
      ["full_time_faculty", "Full-time faculty", 6],
      ["postdoc", "Postdoc", 2],
      [null, "Unclassified", 1],
    ]);
  });

  it("department table defaults to full-time faculty, sorted by NIH-funded-without-ORCID, then people, then label", () => {
    const r = build(parseOrcidCoverageParams({}));
    expect(r.params.types).toEqual(["full_time_faculty"]);
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

  it("the unit match narrows BOTH tables; `type` narrows the department table only", () => {
    // The unit selection resolves (in SQL) to u1 / p1 / f3 — the fold only sees the cwid set.
    const unitMatch = new Set(["u1", "p1", "f3"]);
    const r = buildOrcidCoverage(
      SCHOLARS,
      NIH,
      ERA,
      parseOrcidCoverageParams({ type: "postdoc", unit: "dept:B" }),
      TODAY,
      CANDIDATES,
      [],
      unitMatch,
    );
    expect(r.byRole.map((x) => [x.key, x.people])).toEqual([
      ["full_time_faculty", 1],
      ["postdoc", 1],
      [null, 1],
    ]);
    expect(r.byDept.map((x) => [x.label, x.people])).toEqual([["Dept B", 1]]);
    // Tiles stay the whole population.
    expect(r.tiles.overall.people).toBe(9);
  });

  it("several types OR together; a null role_category never matches a type", () => {
    const r = build(parseOrcidCoverageParams({ type: ["postdoc", "full_time_faculty"] }));
    expect(r.byDept.reduce((n, x) => n + x.people, 0)).toBe(8); // all but u1 (null type)
  });

  it("legacy `role=X&dept=NAME` link: role reads as type=X, dept is ignored", () => {
    const r = build(parseOrcidCoverageParams({ role: "postdoc", dept: "Dept B" }));
    expect(r.byRole.reduce((n, x) => n + x.people, 0)).toBe(9);
    expect(r.byDept.map((x) => [x.label, x.people])).toEqual([
      ["Dept A", 1],
      ["Dept B", 1],
    ]);
  });
});

describe("parseOrcidCoverageParams / orcidCoverageQuery", () => {
  it("a bare visit defaults to full-time faculty; junk nih falls back to all", () => {
    expect(parseOrcidCoverageParams({})).toEqual({
      types: ["full_time_faculty"],
      units: [],
      nih: "all",
      ignoredLegacyDept: false,
    });
    // `dept` alone is not a filter param any more, so it is still a bare visit.
    expect(parseOrcidCoverageParams({ dept: "Dept A" }).types).toEqual(["full_time_faculty"]);
    expect(parseOrcidCoverageParams(new URLSearchParams("nih=junk"))).toEqual({
      types: [],
      units: [],
      nih: "all",
      ignoredLegacyDept: false,
    });
  });

  it("repeated type / unit via the shared parser; a submitted form with no type = every type", () => {
    expect(
      parseOrcidCoverageParams(
        new URLSearchParams("type=postdoc&type=full_time_faculty&unit=dept:AB1&unit=center:C9&nih=current"),
      ),
    ).toEqual({
      types: ["postdoc", "full_time_faculty"],
      units: ["dept:AB1", "center:C9"],
      nih: "current",
      ignoredLegacyDept: false,
    });
    expect(parseOrcidCoverageParams({ nih: "ever" }).types).toEqual([]);
    expect(parseOrcidCoverageParams({ unit: "div:X1" }).types).toEqual([]);
  });

  it("legacy dept=: ignored as a filter, but flagged for the page's notice", () => {
    const p = parseOrcidCoverageParams({ dept: "Dept A", nih: "ever" });
    expect(p.ignoredLegacyDept).toBe(true);
    expect(p.units).toEqual([]);
    expect(parseOrcidCoverageParams(new URLSearchParams("dept=Dept+A")).ignoredLegacyDept).toBe(
      true,
    );
    // The old form's empty "All departments" was never a filter.
    expect(parseOrcidCoverageParams({ dept: "" }).ignoredLegacyDept).toBe(false);
    expect(parseOrcidCoverageParams({ unit: "dept:AB1" }).ignoredLegacyDept).toBe(false);
  });

  it("active filter count: one per type / unit, one for a non-all nih", () => {
    expect(orcidCoverageActiveFilters({ types: [], units: [], nih: "all" })).toBe(0);
    expect(
      orcidCoverageActiveFilters({
        types: ["postdoc"],
        units: ["dept:AB1", "center:C9"],
        nih: "ever",
      }),
    ).toBe(4);
    // The bare-visit default (full-time faculty) is a real filter, so it counts.
    expect(orcidCoverageActiveFilters(parseOrcidCoverageParams({}))).toBe(1);
  });

  it("legacy role: `role=X` → type X, `role=all` → every type, `type` wins over `role`", () => {
    expect(parseOrcidCoverageParams({ role: "postdoc" }).types).toEqual(["postdoc"]);
    expect(parseOrcidCoverageParams({ role: "all" }).types).toEqual([]);
    expect(parseOrcidCoverageParams({ role: "postdoc", type: "fellow" }).types).toEqual(["fellow"]);
  });

  it("round-trips through the query string, including an empty type selection", () => {
    const p = { types: ["postdoc"], units: ["dept:AB1", "inst:WCM"], nih: "current" as const };
    expect(orcidCoverageQuery(p)).toBe("?type=postdoc&unit=dept%3AAB1&unit=inst%3AWCM&nih=current");
    expect(parseOrcidCoverageParams(new URLSearchParams(orcidCoverageQuery(p).slice(1)))).toEqual({
      ...p,
      ignoredLegacyDept: false,
    });
    const all = { types: [], units: [], nih: "all" as const };
    expect(orcidCoverageQuery(all)).toBe("?nih=all");
    expect(parseOrcidCoverageParams(new URLSearchParams(orcidCoverageQuery(all).slice(1)))).toEqual(
      { ...all, ignoredLegacyDept: false },
    );
  });
});

describe("orcidCoverageCsv", () => {
  it("one aggregate row per department, derived columns computed, no per-person data", () => {
    const r = build();
    const csv = orcidCoverageCsv(r.byDept);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Department,People,Asserted ORCID,Confirmed ORCID,Asserted %,Inferred ORCID (strong),Inferred ORCID (weak),eRA account (inferred),Both,Neither,NIH-funded,NIH-funded with asserted ORCID,NIH-funded without asserted ORCID,NIH-funded without asserted but strong inference,NIH PI,NIH PI without eRA account",
    );
    // Dept A: f2 confirmed, f1 from Identity → 2 asserted, 1 confirmed.
    expect(lines).toContain("Dept A,3,2,1,66.7,0,0,1,1,1,1,1,0,0,1,1");
    // Dept B: u1 is a Co-I (not a PI) so its missing eRA row is not a gap; f3 is a PI with one
    // and a strong inference; p1's inference doesn't count — Identity already asserts it.
    expect(lines).toContain("Dept B,3,1,0,33.3,1,1,1,0,1,2,0,2,1,1,0");
    expect(lines).toHaveLength(1 + r.byDept.length);
    expect(csv).not.toMatch(/f1|p1|0000-0002/);
  });
});

describe("orcid coverage export — criteria block + filename", () => {
  const at = new Date("2026-09-22T12:00:00Z");
  const labels = new Map([
    ["dept:AB1", "Medicine"],
    ["center:C9", "Cancer Center"],
  ]);

  it("criteria: report, generated-at, the shared who-filter rows, NIH — All when unset", () => {
    expect(orcidCoverageCriteria({ types: [], units: [], nih: "all" }, at)).toEqual([
      ["Report", "ORCID coverage by department"],
      ["Generated", "2026-09-22T12:00:00.000Z"],
      ["Person type", "All"],
      ["Department / division / center / institution", "All"],
      ["NIH funding", "Everyone"],
    ]);
    const c = orcidCoverageCriteria(
      { types: ["full_time_faculty"], units: ["dept:AB1", "center:C9", "inst:ZZ"], nih: "current" },
      at,
      labels,
    );
    expect(c).toContainEqual(["Department / division / center / institution", "Any of: Medicine; Cancer Center; inst:ZZ"]);
    expect(c).toContainEqual(["NIH funding", "NIH-funded (award ending today or later)"]);
    expect(c.find(([k]) => k === "Person type")?.[1]).not.toBe("All");
  });

  it("the CSV: Filter,Value block, ONE blank line, then the table byte-identical to orcidCoverageCsv", () => {
    const rows = build().byDept;
    const criteria = orcidCoverageCriteria({ types: [], units: ["dept:AB1"], nih: "ever" }, at, labels);
    const csv = orcidCoverageExportCsv(rows, criteria);
    const [head, table, ...rest] = csv.split("\r\n\r\n");
    expect(rest).toEqual([]);
    expect(`${table}`).toBe(orcidCoverageCsv(rows));
    const headLines = head.split("\r\n");
    expect(headLines[0]).toBe("Filter,Value");
    expect(headLines).toContain("Department / division / center / institution,Medicine");
    expect(headLines).toHaveLength(1 + criteria.length);
  });

  it("filename: a sanitized, bounded filter summary; 'all' when nothing is filtered", () => {
    expect(orcidCoverageFilename({ types: [], units: [], nih: "all" }, at)).toBe(
      "orcid-coverage-by-department-all-2026-09-22.csv",
    );
    expect(orcidCoverageFilename({ types: [], units: ["dept:AB1"], nih: "none" }, at, labels)).toBe(
      "orcid-coverage-by-department-medicine-no-nih-2026-09-22.csv",
    );
    const long = orcidCoverageFilename(
      { types: [], units: ['dept:"X";\r\nY', ...Array.from({ length: 20 }, (_, i) => `dept:LONGCODE${i}`)], nih: "current" },
      at,
    );
    const summary = long.slice("orcid-coverage-by-department-".length, -"-2026-09-22.csv".length);
    expect(summary).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(summary.length).toBeLessThanOrEqual(60);
  });
});

/** `orcidVerdict` — the per-cwid fold the home board's ORCID row shares with the console. */
describe("orcidVerdict", () => {
  it("empty → none", () => {
    expect(orcidVerdict([])).toEqual({ tier: "none", orcid: null, accepted: 0 });
  });

  it("a sole rpm_inferred iD at the threshold → strong, with that iD and its accepted count", () => {
    expect(orcidVerdict([cand("x", "rpm_inferred", 3, 0, "iD-a")])).toEqual({
      tier: "strong",
      orcid: "iD-a",
      accepted: 3,
    });
  });

  it("under the threshold, or with a rejection, → weak with no iD", () => {
    expect(orcidVerdict([cand("x", "rpm_inferred", 2, 0, "iD-a")]).tier).toBe("weak");
    expect(orcidVerdict([cand("x", "rpm_inferred", 9, 1, "iD-a")])).toEqual({
      tier: "weak",
      orcid: null,
      accepted: 0,
    });
  });

  it("at the home row's bar (SUGGEST_MIN_ACCEPTED = 1) one accepted article is enough; a competing iD or a rejection still is not", () => {
    expect(SUGGEST_MIN_ACCEPTED).toBe(1);
    expect(orcidVerdict([cand("x", "rpm_inferred", 1, 0, "iD-a")], 1)).toEqual({
      tier: "strong",
      orcid: "iD-a",
      accepted: 1,
    });
    expect(orcidVerdict([cand("x", "rpm_inferred", 1, 0, "iD-a")]).tier).toBe("weak"); // console default
    expect(orcidVerdict([cand("x", "rpm_inferred", 1, 1, "iD-a")], 1).tier).toBe("weak");
    expect(
      orcidVerdict([cand("x", "rpm_inferred", 5, 0, "iD-a"), cand("x", "rpm_inferred", 1, 0, "iD-b")], 1).tier,
    ).toBe("weak");
  });

  it("orcid_crossref is strong at STRONG_MIN_ACCEPTED papers, weak below", () => {
    expect(orcidVerdict([cand("x", "orcid_crossref", 3, 0, "iD-a")])).toEqual({ tier: "strong", orcid: "iD-a", accepted: 0 });
    expect(orcidVerdict([cand("x", "orcid_crossref", 2, 0, "iD-a")]).tier).toBe("weak");
  });

  it("two strong-eligible iDs → weak (no single answer to suggest)", () => {
    expect(
      orcidVerdict([cand("x", "orcid_email", 0, 0, "iD-a"), cand("x", "orcid_works", 5, 0, "iD-b")]).orcid,
    ).toBeNull();
  });

  it("registry-only strength carries accepted=0; RPM+registry agreement carries the RPM count", () => {
    expect(orcidVerdict([cand("x", "orcid_email", 0, 0, "iD-a")])).toEqual({
      tier: "strong",
      orcid: "iD-a",
      accepted: 0,
    });
    expect(
      orcidVerdict([cand("x", "rpm_inferred", 1, 0, "iD-a"), cand("x", "orcid_name", 1, 0, "iD-a")]),
    ).toEqual({ tier: "strong", orcid: "iD-a", accepted: 1 });
  });

  it("an infoed_biosketch row is strong on its own; two biosketch iDs → weak", () => {
    expect(orcidVerdict([cand("x", "infoed_biosketch", 0, 0, "iD-a")])).toEqual({
      tier: "strong",
      orcid: "iD-a",
      accepted: 0,
    });
    expect(
      orcidVerdict([cand("x", "infoed_biosketch", 0, 0, "iD-a"), cand("x", "infoed_biosketch", 0, 0, "iD-b")]).tier,
    ).toBe("weak");
  });

  it("infoed_biosketch_name: weak alone or beside another name-only iD; strong when an independent source agrees", () => {
    expect(orcidVerdict([cand("x", "infoed_biosketch_name", 0, 0, "iD-a")]).tier).toBe("weak");
    expect(
      orcidVerdict([cand("x", "infoed_biosketch_name", 0, 0, "iD-a"), cand("x", "orcid_name", 0, 0, "iD-a")]).tier,
    ).toBe("weak");
    expect(
      orcidVerdict([cand("x", "infoed_biosketch_name", 0, 0, "iD-a"), cand("x", "rpm_inferred", 1, 2, "iD-a")]).tier,
    ).toBe("weak");
    expect(
      orcidVerdict([cand("x", "infoed_biosketch_name", 0, 0, "iD-a"), cand("x", "rpm_inferred", 1, 0, "iD-a")]),
    ).toEqual({ tier: "strong", orcid: "iD-a", accepted: 1 });
  });

  it("an rpm_admin or identity row is a strong candidate, never asserted; a rival strong iD makes it weak", () => {
    expect(orcidVerdict([cand("x", "rpm_admin", 0, 0, "iD-a")])).toEqual({
      tier: "strong",
      orcid: "iD-a",
      accepted: 0,
    });
    expect(orcidVerdict([cand("x", "identity", 0, 0, "iD-a")])).toEqual({
      tier: "strong",
      orcid: "iD-a",
      accepted: 0,
    });
    expect(
      orcidVerdict([cand("x", "rpm_inferred", 9, 0, "iD-b"), cand("x", "rpm_admin", 0, 0, "iD-a")]),
    ).toEqual({ tier: "weak", orcid: null, accepted: 0 });
  });

  it("orcidTiers is exactly the verdict tier per cwid", () => {
    const rows = [cand("x", "rpm_inferred", 3), cand("y", "rpm_inferred", 1), cand("z", "rpm_admin")];
    expect([...orcidTiers(rows)]).toEqual([
      ["x", "strong"],
      ["y", "weak"],
      ["z", "strong"],
    ]);
  });
});

/** `withoutDismissed` — the one filter every `orcid_candidate` reader applies. */
describe("withoutDismissed", () => {
  it("drops exactly the dismissed (cwid, iD) pairs, every source; another cwid's same iD and another iD survive", () => {
    const rows = [
      cand("y1", "rpm_admin", 0, 0, "iD-a"),
      cand("x1", "orcid_email", 0, 0, "iD-a"),
      cand("x1", "rpm_inferred", 3, 0, "iD-b"),
      cand("x1", "rpm_admin", 0, 0, "iD-a"),
    ];
    // Upper-case cwid on the dismissal: compared lowercase, like the ETLs.
    const kept = withoutDismissed(rows, [{ cwid: "X1", orcid: "iD-a" }]);
    expect(kept.map((r) => `${r.cwid}|${r.orcid}|${r.source}`)).toEqual([
      "y1|iD-a|rpm_admin",
      "x1|iD-b|rpm_inferred",
    ]);
    expect(withoutDismissed(rows, [])).toEqual(rows);
  });
});

/** `loadOrcidCoverage` — the reads reach the fold: `orcid_confirmed_at` and `orcid_dismissal`. */
describe("loadOrcidCoverage", () => {
  it("reads orcidConfirmedAt and the dismissals, and the fold applies both", async () => {
    const scholarFindMany = vi.fn().mockResolvedValue([
      s("f2", "full_time_faculty", "Dept A", true, true),
      s("f1", "full_time_faculty", "Dept A", true),
      s("f6", "full_time_faculty", "Dept C"),
    ]);
    const fake = {
      scholar: { findMany: scholarFindMany },
      grant: { groupBy: vi.fn().mockResolvedValue([]) },
      personNihProfile: { findMany: vi.fn().mockResolvedValue([]) },
      orcidCandidate: { findMany: vi.fn().mockResolvedValue([cand("f6", "rpm_admin")]) },
      orcidDismissal: {
        findMany: vi.fn().mockResolvedValue([{ cwid: "f6", orcid: "iD-a" }]),
      },
    };
    const r = await loadOrcidCoverage(fake as unknown as OrcidCoverageClient, ALL);
    expect(scholarFindMany.mock.calls[0][0].select).toMatchObject({ orcidConfirmedAt: true });
    expect(r.tiles.overall).toMatchObject({ people: 3, orcid: 2, confirmed: 1, strong: 0, weak: 0 });
  });

  it("a unit selection is resolved by one raw read through personFilterSql; none → no read", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ cwid: "f1" }]);
    const fake = {
      scholar: {
        findMany: vi.fn().mockResolvedValue([
          s("f1", "full_time_faculty", "Dept A", true),
          s("f6", "full_time_faculty", "Dept C"),
        ]),
      },
      grant: { groupBy: vi.fn().mockResolvedValue([]) },
      personNihProfile: { findMany: vi.fn().mockResolvedValue([]) },
      orcidCandidate: { findMany: vi.fn().mockResolvedValue([]) },
      orcidDismissal: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: queryRaw,
    };
    const client = fake as unknown as OrcidCoverageClient;
    await loadOrcidCoverage(client, ALL);
    expect(queryRaw).not.toHaveBeenCalled();

    const r = await loadOrcidCoverage(client, parseOrcidCoverageParams({ unit: "dept:AB1" }));
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sqlText = JSON.stringify(queryRaw.mock.calls[0]);
    expect(sqlText).toContain("dept_code");
    expect(sqlText).toContain("AB1");
    expect(r.byDept.map((x) => [x.label, x.people])).toEqual([["Dept A", 1]]);
    expect(r.byRole.reduce((n, x) => n + x.people, 0)).toBe(1);
    expect(r.tiles.overall.people).toBe(2);
  });
});

describe("inferenceSourceCounts", () => {
  const row = (
    cwid: string,
    source: string,
    articlesAccepted = 0,
    articlesRejected = 0,
    orcid = `iD-${cwid}-${source}`,
  ): CandidateRow => ({ cwid, orcid, source, articlesAccepted, articlesRejected });

  it("counts distinct people per rule, overlapping, within the population only", () => {
    const candidates = [
      row("a1", "rpm_inferred", 5, 0), // rpm strong
      row("a1", "rpm_inferred", 1, 0, "iD-other"), // same person, second row: still one person
      row("a2", "rpm_inferred", 5, 1), // a rejection → weak
      row("a3", "rpm_inferred", 2, 0), // too few → weak
      row("a1", "orcid_email"), // registry strong (email); a1 also counted under RPM
      row("a4", "orcid_works", 3), // registry strong (works)
      row("a5", "orcid_works", 2), // under the bar → registry weak
      row("a6", "orcid_name"), // registry weak
      row("a4", "orcid_name"), // a4 already strong in the registry → not weak
      row("a8", "orcid_crossref", 4), // registry strong (Crossref)
      row("a8", "orcid_name"), // a8 strong via Crossref → not weak
      row("a7", "rpm_admin"), // typed in by an admin: not an inference
      row("gone", "orcid_email"), // not in the active population
    ];
    const population = new Set(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
    expect(inferenceSourceCounts(candidates, population)).toEqual({
      rpmStrong: 1,
      rpmWeak: 2,
      registryEmail: 1,
      registryWorks: 1,
      registryCrossref: 1,
      registryWeak: 2,
    });
  });

  it("rides on buildOrcidCoverage, after dismissals", () => {
    const scholars: ScholarRow[] = [
      {
        cwid: "b1",
        roleCategory: null,
        primaryDepartment: null,
        orcid: null,
        orcidConfirmedAt: null,
      },
    ];
    const cands = [row("b1", "orcid_email", 0, 0, "iD-x")];
    const today = new Date("2026-09-18T00:00:00Z");
    const params = parseOrcidCoverageParams({});
    expect(buildOrcidCoverage(scholars, [], [], params, today, cands).sources.registryEmail).toBe(
      1,
    );
    expect(
      buildOrcidCoverage(scholars, [], [], params, today, cands, [{ cwid: "b1", orcid: "iD-x" }])
        .sources.registryEmail,
    ).toBe(0);
  });
});

describe("campus: WCM (default), Cornell Ithaca, both", () => {
  const ith = (cwid: string, roleCategory: string, dept: string | null, orcid = false): ScholarRow => ({
    ...s(cwid, roleCategory, dept, orcid, orcid),
    campus: "ithaca",
  });
  // Anti-sorted against ITHACA_ROLES, and the biggest role (grad students) is last in it.
  // "Dept A" also exists at WCM: the two must stay two rows.
  const ITHACA: ScholarRow[] = [
    ith("ig1", "ithaca_student_grad", "Physics"),
    ith("ig2", "ithaca_student_grad", "Physics"),
    ith("ig3", "ithaca_student_grad", "Dept A"),
    ith("ir1", "ithaca_researcher", "Physics"),
    ith("ip1", "ithaca_postdoc", "Physics", true),
    ith("ie1", "ithaca_emeritus", null),
    ith("it1", "ithaca_rte_faculty", "Dept A"),
    ith("if1", "ithaca_faculty", "Physics", true),
    ith("if2", "ithaca_faculty", "Dept A"),
  ];
  const WCM = SCHOLARS.map((r) => ({ ...r, campus: "wcm" }));
  // An Ithaca cwid string on a grant and an eRA row: nothing WCM-only may count it.
  const NIH_X = [...NIH, { cwid: "if1", latestEnd: new Date("2030-01-01T00:00:00Z"), pi: true }];
  const ERA_X = [...ERA, "if1"];
  const fold = (rows: ScholarRow[], raw: Record<string, string | string[]>, unit: Set<string> | null = null) =>
    buildOrcidCoverage(rows, NIH_X, ERA_X, parseOrcidCoverageParams(raw), TODAY, CANDIDATES, [], unit);
  const strip = <T extends { campus?: string }>(rows: T[]) =>
    rows.map((r) => {
      const copy = { ...r };
      delete copy.campus;
      return copy;
    });

  it("parse: absent campus is exactly the pre-campus parse; ithaca and all opt in; unknown → WCM", () => {
    expect(parseOrcidCoverageParams({})).toEqual({
      types: ["full_time_faculty"],
      units: [],
      nih: "all",
      ignoredLegacyDept: false,
    });
    expect(parseOrcidCoverageParams({ type: "postdoc", unit: "dept:AB1", nih: "ever" })).toEqual({
      types: ["postdoc"],
      units: ["dept:AB1"],
      nih: "ever",
      ignoredLegacyDept: false,
    });
    expect(parseOrcidCoverageParams({ campus: "all", nih: "ever", unit: "dept:AB1" })).toMatchObject({
      campus: "all",
      nih: "ever",
      units: ["dept:AB1"],
      types: [],
    });
    // NIH and unit are WCM concepts: an Ithaca-only view drops them.
    expect(parseOrcidCoverageParams({ campus: "ithaca", nih: "ever", unit: "dept:AB1" })).toEqual({
      types: [],
      units: [],
      nih: "all",
      campus: "ithaca",
      ignoredLegacyDept: false,
    });
    for (const junk of ["mars", "ALL", "wcm", ""]) {
      const p = parseOrcidCoverageParams({ campus: junk, nih: "ever" });
      expect(p).not.toHaveProperty("campus");
      expect(p).toEqual(parseOrcidCoverageParams({ nih: "ever" }));
      expect(orcidCoverageQuery(p)).toBe("?nih=ever");
    }
    expect(parseOrcidCoverageParams(new URLSearchParams("campus=all")).campus).toBe("all");
  });

  it("parse: an unknown campus on an otherwise bare visit is the bare visit, default person type included", () => {
    const bare = parseOrcidCoverageParams({});
    expect(bare.types).toEqual(["full_time_faculty"]);
    for (const junk of ["bogus", "ALL", "wcm", ""]) {
      expect(parseOrcidCoverageParams({ campus: junk })).toEqual(bare);
      expect(parseOrcidCoverageParams(new URLSearchParams({ campus: junk }))).toEqual(bare);
    }
    // The first value decides, as for every other parameter here.
    expect(parseOrcidCoverageParams({ campus: ["", "ithaca"] })).toEqual(bare);
    // A recognized campus is a choice: every person type, as on the base branch.
    expect(parseOrcidCoverageParams({ campus: "ithaca" }).types).toEqual([]);
    expect(parseOrcidCoverageParams({ campus: "all" }).types).toEqual([]);
    // An unknown campus beside a real filter changes nothing either.
    expect(parseOrcidCoverageParams({ campus: "bogus", type: "postdoc" })).toEqual(
      parseOrcidCoverageParams({ type: "postdoc" }),
    );
  });

  it("query, active-filter count, criteria and filename carry the campus view", () => {
    const all = parseOrcidCoverageParams({ campus: "all", nih: "ever" });
    expect(orcidCoverageQuery(all)).toBe("?nih=ever&campus=all");
    expect(parseOrcidCoverageParams(new URLSearchParams(orcidCoverageQuery(all).slice(1)))).toMatchObject(all);
    expect(orcidCoverageActiveFilters(all)).toBe(2);
    expect(orcidCoverageActiveFilters(parseOrcidCoverageParams({ nih: "ever" }))).toBe(1);
    const at = new Date("2026-11-18T12:00:00Z");
    expect(orcidCoverageCriteria(all, at).map(([k]) => k)).toEqual([
      ...orcidCoverageCriteria(parseOrcidCoverageParams({ nih: "ever" }), at).map(([k]) => k),
      "Campus",
      "Campus note",
    ]);
    expect(orcidCoverageFilename(all, at)).toBe(
      "orcid-coverage-by-department-nih-ever-both-campuses-2026-11-18.csv",
    );
  });

  it("no campus: the fold and the CSV carry no campus anything, whatever the rows say", () => {
    const before = build(parseOrcidCoverageParams({ nih: "ever" }));
    const tagged = fold(WCM, { nih: "ever" });
    expect(tagged).not.toHaveProperty("campuses");
    for (const r of [...tagged.byRole, ...tagged.byDept]) expect(r).not.toHaveProperty("campus");
    expect(JSON.stringify({ ...tagged, sources: 0 })).toBe(JSON.stringify({ ...before, sources: 0 }));
    expect(orcidCoverageCsv(tagged.byDept)).toBe(orcidCoverageCsv(before.byDept));
    expect(orcidCoverageCsv(tagged.byDept).startsWith("Department,People,")).toBe(true);
  });

  it("Cornell Ithaca: the six roles in roster order with their labels; departments by the Cornell department", () => {
    const r = fold(ITHACA, { campus: "ithaca" });
    expect(r.byRole.map((x) => [x.label, x.people])).toEqual([
      ["Cornell Ithaca faculty", 2],
      ["Cornell Ithaca RTE faculty", 1],
      ["Cornell Ithaca emeritus", 1],
      ["Cornell Ithaca postdoc", 1],
      ["Cornell Ithaca research staff", 1],
      ["Cornell Ithaca grad student", 3],
    ]);
    expect(r.byDept.map((x) => [x.label, x.people, x.orcid])).toEqual([
      ["Physics", 5, 2],
      ["Dept A", 3, 0],
      ["No department", 1, 0],
    ]);
    // Headline tile = Ithaca faculty; no NIH tile population.
    expect(r.tiles.overall).toMatchObject({ people: 9, orcid: 2, confirmed: 2 });
    expect(r.tiles.fullTime).toMatchObject({ people: 2, orcid: 1 });
    expect(r.tiles.nihFullTime.people).toBe(0);
    // if1 sits on a grant and an eRA row by cwid string: still nothing WCM-only.
    for (const c of [r.tiles.overall, ...r.byRole, ...r.byDept]) {
      expect([c.era, c.both, c.nihPeople, c.nihOrcid, c.nihStrong, c.nihPi, c.nihPiEra]).toEqual([
        0, 0, 0, 0, 0, 0, 0,
      ]);
    }
    // `type` narrows the department table only, as at WCM.
    const fac = fold(ITHACA, { campus: "ithaca", type: "ithaca_faculty" });
    expect(fac.byDept.map((x) => [x.label, x.people])).toEqual([
      ["Dept A", 1],
      ["Physics", 1],
    ]);
    expect(fac.byRole).toEqual(r.byRole);
    // The Ithaca CSV keeps the one-campus columns.
    expect(orcidCoverageCsv(r.byDept).split("\r\n")[0]).toBe(orcidCoverageCsv([]).trimEnd());
  });

  it("both: each half is exactly its one-campus fold, and the totals are WCM + Ithaca", () => {
    const wcm = fold(WCM, {});
    const ithaca = fold(ITHACA, { campus: "ithaca" });
    const all = fold([...ITHACA, ...WCM], { campus: "all", type: "full_time_faculty" });
    const [w, i] = all.campuses!;
    expect([w.campus, w.label, i.campus, i.label]).toEqual([
      "wcm",
      "Weill Cornell Medicine",
      "ithaca",
      "Cornell Ithaca",
    ]);
    expect(w.tiles).toEqual(wcm.tiles);
    expect(i.tiles).toEqual(ithaca.tiles);
    for (const k of Object.keys(wcm.tiles.overall) as (keyof typeof wcm.tiles.overall)[]) {
      expect(all.tiles.overall[k]).toBe(wcm.tiles.overall[k] + ithaca.tiles.overall[k]);
      expect(all.tiles.fullTime[k]).toBe(wcm.tiles.fullTime[k] + ithaca.tiles.fullTime[k]);
      expect(w.total[k] + i.total[k]).toBe(all.tiles.overall[k]);
    }
    // Person types: WCM's rows then Ithaca's, each tagged; the subtotal is their sum.
    expect(all.byRole.map((r) => r.campus)).toEqual([
      ...wcm.byRole.map(() => "wcm"),
      ...ithaca.byRole.map(() => "ithaca"),
    ]);
    expect(strip(all.byRole)).toEqual([...wcm.byRole, ...ithaca.byRole]);
    expect(w.total.people).toBe(wcm.byRole.reduce((n, r) => n + r.people, 0));
    expect(i.total.people).toBe(9);
    // Departments: `type` is literal, so a WCM-only type leaves no Ithaca department.
    expect(all.byDept.every((r) => r.campus === "wcm")).toBe(true);
    expect(strip(all.byDept).sort((a, b) => a.label.localeCompare(b.label))).toEqual(
      [...wcm.byDept].sort((a, b) => a.label.localeCompare(b.label)),
    );
  });

  it("both: one department list, people desc, a same-named department once per campus", () => {
    const all = fold([...WCM, ...ITHACA], { campus: "all" });
    expect(all.byDept.map((r) => [r.campus, r.label, r.people])).toEqual([
      ["ithaca", "Physics", 5],
      ["wcm", "Dept A", 3],
      ["ithaca", "Dept A", 3],
      ["wcm", "Dept B", 3],
      ["wcm", "Dept C", 2],
      ["wcm", "No department", 1],
      ["ithaca", "No department", 1],
    ]);
  });

  it("both: the NIH and unit filters narrow the WCM half only", () => {
    const all = fold([...WCM, ...ITHACA], { campus: "all", nih: "current" }, new Set(["f2", "f5", "ig1"]));
    const [w, i] = all.campuses!;
    expect(w.total.people).toBe(2); // f2 + f5: current AND in the unit
    expect(i.total.people).toBe(9); // untouched
    expect(all.byRole.filter((r) => r.campus === "ithaca").map((r) => r.people)).toEqual([
      2, 1, 1, 1, 1, 3,
    ]);
    // Tiles stay unfiltered.
    expect(w.tiles.overall.people).toBe(9);
  });

  it("both CSV: a leading Campus column; Ithaca rows leave the eRA and NIH cells blank", () => {
    const all = fold([...WCM, ...ITHACA], { campus: "all" });
    const lines = orcidCoverageCsv(all.byDept, true).trimEnd().split("\r\n");
    expect(lines[0]).toBe(`Campus,${orcidCoverageCsv([]).trimEnd()}`);
    expect(lines).toContain("Cornell Ithaca,Physics,5,2,2,40.0,0,0,,,,,,,,,");
    expect(lines).toContain("Weill Cornell Medicine,Dept A,3,2,1,66.7,0,0,1,1,1,1,1,0,0,1,1");
    expect(lines).toHaveLength(1 + all.byDept.length);
    expect(lines.join("\n")).not.toMatch(/if1|ig1|0000-0002/);
    // Without the flag the same rows print the one-campus columns.
    expect(orcidCoverageCsv(all.byDept).startsWith("Department,")).toBe(true);
    const exported = orcidCoverageExportCsv(all.byDept, [["Campus", "Both"]], true);
    expect(exported).toBe(`Filter,Value\r\nCampus,Both\r\n\r\n${orcidCoverageCsv(all.byDept, true)}`);
  });

  it("loader: WCM and Ithaca reads are unchanged; all reads both populations plus campus", async () => {
    const findMany = vi.fn().mockResolvedValue([...WCM, ...ITHACA]);
    const queryRaw = vi.fn().mockResolvedValue([{ cwid: "f1" }]);
    const client = {
      scholar: { findMany },
      grant: { groupBy: vi.fn().mockResolvedValue([]) },
      personNihProfile: { findMany: vi.fn().mockResolvedValue([]) },
      orcidCandidate: { findMany: vi.fn().mockResolvedValue([]) },
      orcidDismissal: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: queryRaw,
    } as unknown as OrcidCoverageClient;
    const select = {
      cwid: true,
      roleCategory: true,
      primaryDepartment: true,
      orcid: true,
      orcidConfirmedAt: true,
    };
    await loadOrcidCoverage(client, parseOrcidCoverageParams({ nih: "all" }));
    expect(findMany.mock.calls[0][0]).toEqual({ where: { deletedAt: null, status: "active" }, select });
    await loadOrcidCoverage(client, parseOrcidCoverageParams({ campus: "ithaca" }));
    expect(findMany.mock.calls[1][0]).toEqual({
      where: { deletedAt: null, campus: "ithaca", status: "external" },
      select,
    });
    const r = await loadOrcidCoverage(client, parseOrcidCoverageParams({ campus: "all", unit: "dept:AB1" }));
    expect(findMany.mock.calls[2][0]).toEqual({
      where: {
        deletedAt: null,
        OR: [{ status: "active" }, { campus: "ithaca", status: "external" }],
      },
      select: { ...select, campus: true },
    });
    // The unit read stays WCM's (status = active): it can only ever match WCM rows.
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(r.campuses!.map((c) => c.total.people)).toEqual([1, 9]);
  });
});

/** Open authorship rows waiting on an ORCID confirmation: `openAuthorshipImpact` (the
 *  staleness gate) and the fold's per-person sum over unconfirmed iDs. */
describe("open authorship rows waiting", () => {
  const NOW = new Date("2026-11-18T12:00:00Z");
  const FRESH = new Date("2026-11-18T03:00:00Z");
  const A = "0000-0002-1825-0097"; // the iD `s(…, true)` puts on scholar.orcid
  const B = "0000-0001-0000-000X";
  const C = "0000-0001-0000-0003";
  const D = "0000-0001-0000-0004";
  const E = "0000-0001-0000-0005";
  const open = (orcid: string, openRows: number, refreshedAt = FRESH) => ({
    orcid,
    openRows,
    refreshedAt,
  });
  const c = (cwid: string, orcid: string, source: string): CandidateRow => ({
    cwid,
    orcid,
    source,
    articlesAccepted: 5,
    articlesRejected: 0,
  });
  const PEOPLE: ScholarRow[] = [
    s("w1", "full_time_faculty", "Dept A", true, true), // confirmed A
    { ...s("w2", "full_time_faculty", "Dept A", true), orcid: E }, // holds E, unconfirmed (Identity)
    s("w3", "full_time_faculty", "Dept B"), // candidate B from two sources
    s("w4", "postdoc", "Dept B"), // candidates C (dismissed) and D
    s("w5", "postdoc", "Dept B"), // nothing on file
  ];
  const CANDS = [
    c("w1", B, "rpm_inferred"), // a second iD beside a confirmed one: still 0
    c("w3", B, "rpm_inferred"),
    c("W3", B.toLowerCase(), "orcid_works"), // same person, same iD, another source
    c("w4", C, "orcid_name"),
    c("w4", D, "orcid_email"),
  ];
  const DISMISSED = [{ cwid: "w4", orcid: C }];
  // A is w1's confirmed iD: its open rows wait on nobody.
  const IMPACT = openAuthorshipImpact(
    [open(A, 50), open(B, 7), open(C, 100), open(D, 2), open(E, 10)],
    NOW,
  )!;
  const ALL_TYPES = parseOrcidCoverageParams({ nih: "all" });
  const run = (
    impact: ReturnType<typeof openAuthorshipImpact>,
    params = ALL_TYPES,
    scholars = PEOPLE,
    dismissals = DISMISSED,
  ) => buildOrcidCoverage(scholars, [], [], params, TODAY, CANDS, dismissals, null, impact);

  it("openAuthorshipImpact: an empty table or a copy older than 48 hours is nothing to show", () => {
    expect(openAuthorshipImpact([], NOW)).toBeNull();
    const hours = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    expect(OPEN_AUTHORSHIP_MAX_AGE_HOURS).toBe(48);
    expect(openAuthorshipImpact([open(A, 1, hours(49))], NOW)).toBeNull();
    const edge = openAuthorshipImpact([open(A, 1, hours(48))], NOW);
    expect(edge?.refreshedAt).toEqual(hours(48));
    // The newest row dates the copy; iDs are keyed bare and upper-case.
    const mixed = openAuthorshipImpact(
      [open(A, 1, hours(60)), open(B.toLowerCase(), 3, hours(1))],
      NOW,
    );
    expect(mixed?.refreshedAt).toEqual(hours(1));
    expect([...mixed!.byOrcid]).toEqual([
      [A, 1],
      [B, 3],
    ]);
  });

  it("sums open rows over each person's unconfirmed iDs; a confirmed person contributes 0", () => {
    const r = run(IMPACT);
    const dept = Object.fromEntries(
      r.byDept.map((d) => [d.label, [d.waitingRows, d.waitingPeople]]),
    );
    // Dept A: w1 confirmed → 0 (its candidate B ignored too); w2 holds E unconfirmed → 10.
    expect(dept["Dept A"]).toEqual([10, 1]);
    // Dept B: w3 → B once (7, not 14); w4 → D only (2; C is dismissed); w5 → 0.
    expect(dept["Dept B"]).toEqual([9, 2]);
    const role = Object.fromEntries(r.byRole.map((d) => [d.key, [d.waitingRows, d.waitingPeople]]));
    expect(role).toEqual({ full_time_faculty: [17, 2], postdoc: [2, 1] });
    expect(r.impact).toEqual({ refreshedAt: FRESH, rows: 19, people: 3 });
  });

  it("a dismissed pair is excluded: as a candidate, and as scholar.orcid", () => {
    // Without the dismissal w4's C counts.
    expect(run(IMPACT, ALL_TYPES, PEOPLE, []).impact).toMatchObject({ rows: 119, people: 3 });
    // w2 dismissed the very iD on scholar.orcid: it counts nowhere.
    expect(
      run(IMPACT, ALL_TYPES, PEOPLE, [...DISMISSED, { cwid: "w2", orcid: E }]).impact,
    ).toMatchObject({
      rows: 9,
      people: 2,
    });
  });

  it("no impact data (empty or stale table): no waiting fields anywhere, and the result is what it was", () => {
    const without = buildOrcidCoverage(PEOPLE, [], [], ALL_TYPES, TODAY, CANDS, DISMISSED);
    const stale = run(openAuthorshipImpact([open(A, 10, new Date("2026-11-15T00:00:00Z"))], NOW));
    expect(JSON.stringify(stale)).toBe(JSON.stringify(without));
    expect(stale).not.toHaveProperty("impact");
    for (const row of [...stale.byRole, ...stale.byDept, stale.tiles.overall]) {
      expect(row).not.toHaveProperty("waitingRows");
      expect(row).not.toHaveProperty("waitingPeople");
    }
    // Fresh data changes nothing but the added fields.
    const strip = (o: unknown) =>
      JSON.stringify(o, (k, v) =>
        k === "waitingRows" || k === "waitingPeople" || k === "impact" ? undefined : v,
      );
    expect(strip(run(IMPACT))).toBe(strip(without));
  });

  it("the tile follows unit + NIH (the person-type table), not the type filter", () => {
    const fac = run(IMPACT, parseOrcidCoverageParams({ type: "postdoc", nih: "all" }));
    expect(fac.impact).toMatchObject({ rows: 19, people: 3 });
    expect(fac.byDept.map((d) => [d.label, d.waitingRows])).toEqual([["Dept B", 2]]);
    const unit = buildOrcidCoverage(
      PEOPLE,
      [],
      [],
      ALL_TYPES,
      TODAY,
      CANDS,
      DISMISSED,
      new Set(["w2"]),
      IMPACT,
    );
    expect(unit.impact).toMatchObject({ rows: 10, people: 1 });
  });

  it("an iD two people hold counts its rows once per line and once per total; both people count", () => {
    // Namesakes x1 (Dept A) and x2, x3 (Dept B) all carry B as a candidate: 7 open rows exist.
    const people = [
      s("x1", "full_time_faculty", "Dept A"),
      s("x2", "full_time_faculty", "Dept B"),
      s("x3", "postdoc", "Dept B"),
    ];
    const r = buildOrcidCoverage(
      people,
      [],
      [],
      ALL_TYPES,
      TODAY,
      [c("x1", B, "orcid_name"), c("x2", B, "orcid_name"), c("x3", B, "orcid_name")],
      [],
      null,
      IMPACT,
    );
    expect(
      Object.fromEntries(r.byDept.map((d) => [d.label, [d.waitingRows, d.waitingPeople]])),
    ).toEqual({
      "Dept A": [7, 1],
      "Dept B": [7, 2],
    });
    expect(
      Object.fromEntries(r.byRole.map((d) => [d.key, [d.waitingRows, d.waitingPeople]])),
    ).toEqual({
      full_time_faculty: [7, 2],
      postdoc: [7, 1],
    });
    // Never more than the open rows that exist.
    expect(r.impact).toMatchObject({ rows: 7, people: 3 });
  });

  it("an iD anyone has confirmed waits on nobody: a namesake's candidate, or another campus's row", () => {
    // y1 confirmed A; y2 (a namesake) and the Ithaca row n1 hold A as a candidate.
    const y1 = s("y1", "full_time_faculty", "Dept A", true, true);
    const y2 = s("y2", "full_time_faculty", "Dept B");
    const n1 = { ...s("n1", "ithaca_faculty", "Physics"), campus: "ithaca" };
    const cands = [c("y2", A, "orcid_name"), c("n1", A, "cornell_affiliation_manager")];
    const fold = (rows: ScholarRow[], raw: Record<string, string>, impact = IMPACT) =>
      buildOrcidCoverage(
        rows,
        [],
        [],
        parseOrcidCoverageParams(raw),
        TODAY,
        cands,
        [],
        null,
        impact,
      );
    expect(fold([y1, y2], { nih: "all" }).impact).toMatchObject({ rows: 0, people: 0 });
    const both = fold([y1, y2, n1], { campus: "all" });
    expect(both.campuses!.map((x) => [x.total.waitingRows, x.total.waitingPeople])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(both.impact).toMatchObject({ rows: 0, people: 0 });
    // Until y1 confirms, the rows do wait (once, though two WCM people and n1 hold the iD).
    const unconfirmed = fold([{ ...y1, orcidConfirmedAt: null }, y2, n1], { campus: "all" });
    expect(unconfirmed.impact).toMatchObject({ rows: 50, people: 3 });
    // The Ithaca-only view never loads y1: the loader hands the confirmed iDs to
    // openAuthorshipImpact, which leaves them out.
    expect(fold([n1], { campus: "ithaca" }).impact).toMatchObject({ rows: 50, people: 1 });
    const known = openAuthorshipImpact([open(A, 50), open(B, 7)], NOW, [
      `https://orcid.org/${A.toLowerCase()}`,
    ])!;
    expect([...known.byOrcid]).toEqual([[B, 7]]);
    expect(fold([n1], { campus: "ithaca" }, known).impact).toMatchObject({ rows: 0, people: 0 });
  });

  it("both campuses: each campus's subtotal carries its own rows; the total counts a shared iD once", () => {
    const ithaca: ScholarRow[] = [
      { ...s("n1", "ithaca_faculty", "Physics"), campus: "ithaca" },
      { ...s("n2", "ithaca_postdoc", "Physics", true, true), campus: "ithaca" },
    ];
    const r = buildOrcidCoverage(
      [...PEOPLE.map((p) => ({ ...p, campus: "wcm" })), ...ithaca],
      [],
      [],
      parseOrcidCoverageParams({ campus: "all", nih: "all" }),
      TODAY,
      [
        ...CANDS,
        c("n1", D, "cornell_affiliation_manager"),
        c("n2", D, "cornell_affiliation_manager"),
      ],
      DISMISSED,
      null,
      IMPACT,
    );
    const [w, i] = r.campuses!;
    expect([w.total.waitingRows, w.total.waitingPeople]).toEqual([19, 3]);
    // n1 → D (2); n2 is confirmed → 0.
    expect([i.total.waitingRows, i.total.waitingPeople]).toEqual([2, 1]);
    // D is held on both campuses (w4, n1): 2 in each subtotal, once in the total.
    expect(r.impact).toMatchObject({ rows: 19, people: 4 });
    const one = buildOrcidCoverage(
      ithaca,
      [],
      [],
      parseOrcidCoverageParams({ campus: "ithaca" }),
      TODAY,
      [c("n1", D, "cornell_affiliation_manager")],
      [],
      null,
      IMPACT,
    );
    expect(one.impact).toMatchObject({ rows: 2, people: 1 });
  });

  it("CSV: the column and the criteria date appear only with impact data; without, byte-identical", () => {
    const r = run(IMPACT);
    const plain = orcidCoverageCsv(r.byDept);
    expect(plain).toBe(
      orcidCoverageCsv(
        buildOrcidCoverage(PEOPLE, [], [], ALL_TYPES, TODAY, CANDS, DISMISSED).byDept,
      ),
    );
    expect(plain.split("\r\n")[0]).not.toContain(CSV_WAITING_HEADER);
    const lines = orcidCoverageCsv(r.byDept, false, true).split("\r\n");
    expect(lines[0]).toBe(`${plain.split("\r\n")[0]},${CSV_WAITING_HEADER}`);
    const byLabel = Object.fromEntries(
      lines.slice(1).map((l) => [l.split(",")[0], l.split(",").at(-1)]),
    );
    expect(byLabel).toMatchObject({ "Dept A": "10", "Dept B": "9" });
    // Each data line is the plain line plus the one cell.
    plain
      .split("\r\n")
      .slice(1)
      .forEach((l, n) => {
        if (l !== "") expect(lines[n + 1].startsWith(`${l},`)).toBe(true);
      });
    const at = new Date("2026-11-18T12:00:00Z");
    expect(orcidCoverageCriteria(ALL_TYPES, at, new Map(), r.impact)).toEqual([
      ...orcidCoverageCriteria(ALL_TYPES, at),
      ["Open authorship rows as of", FRESH.toISOString()],
    ]);
    expect(orcidCoverageExportCsv(r.byDept, [], false, true)).toContain(CSV_WAITING_HEADER);
    expect(orcidCoverageExportCsv(r.byDept, [])).not.toContain(CSV_WAITING_HEADER);
    // campus=all: the cell is filled for Cornell Ithaca too (it is not a WCM-only fact).
    const both = orcidCoverageCsv(
      [{ ...r.byDept[0], campus: "ithaca", waitingRows: 4 }],
      true,
      true,
    ).split("\r\n");
    expect(both[0].startsWith("Campus,Department,")).toBe(true);
    expect(both[1].endsWith(",4")).toBe(true);
  });

  it("loadOrcidCoverage reads orcid_open_authorship; a failed read hides the numbers, not the page", async () => {
    // The second scholar read (every confirmed iD) happens only when there are counts.
    const confirmedIds = vi.fn().mockResolvedValue([] as { orcid: string }[]);
    const findMany = vi.fn((args: { where: Record<string, unknown> }) =>
      "orcidConfirmedAt" in args.where
        ? confirmedIds(args)
        : Promise.resolve([s("w2", "full_time_faculty", "Dept A", true)]),
    );
    const base = {
      scholar: { findMany },
      grant: { groupBy: vi.fn().mockResolvedValue([]) },
      personNihProfile: { findMany: vi.fn().mockResolvedValue([]) },
      orcidCandidate: { findMany: vi.fn().mockResolvedValue([]) },
      orcidDismissal: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const fresh = new Date(Date.now() - 3_600_000);
    const ok = await loadOrcidCoverage(
      {
        ...base,
        orcidOpenAuthorship: { findMany: vi.fn().mockResolvedValue([open(A, 6, fresh)]) },
      } as unknown as OrcidCoverageClient,
      ALL_TYPES,
    );
    expect(ok.impact).toEqual({ refreshedAt: fresh, rows: 6, people: 1 });
    expect(confirmedIds).toHaveBeenCalledWith({
      where: { deletedAt: null, orcid: { not: null }, orcidConfirmedAt: { not: null } },
      select: { orcid: true },
    });
    // Someone outside the counted people (another campus, say) confirmed that iD.
    confirmedIds.mockResolvedValueOnce([{ orcid: A }]);
    const settled = await loadOrcidCoverage(
      {
        ...base,
        orcidOpenAuthorship: { findMany: vi.fn().mockResolvedValue([open(A, 6, fresh)]) },
      } as unknown as OrcidCoverageClient,
      ALL_TYPES,
    );
    expect(settled.impact).toEqual({ refreshedAt: fresh, rows: 0, people: 0 });
    // An empty table: no second read at all.
    confirmedIds.mockClear();
    await loadOrcidCoverage(
      {
        ...base,
        orcidOpenAuthorship: { findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as OrcidCoverageClient,
      ALL_TYPES,
    );
    expect(confirmedIds).not.toHaveBeenCalled();

    const old = await loadOrcidCoverage(
      {
        ...base,
        orcidOpenAuthorship: {
          findMany: vi.fn().mockResolvedValue([open(A, 6, new Date(Date.now() - 49 * 3_600_000))]),
        },
      } as unknown as OrcidCoverageClient,
      ALL_TYPES,
    );
    expect(old).not.toHaveProperty("impact");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failed = await loadOrcidCoverage(
      {
        ...base,
        orcidOpenAuthorship: { findMany: vi.fn().mockRejectedValue(new Error("no such table")) },
      } as unknown as OrcidCoverageClient,
      ALL_TYPES,
    );
    expect(failed).not.toHaveProperty("impact");
    expect(failed.tiles.overall.people).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
