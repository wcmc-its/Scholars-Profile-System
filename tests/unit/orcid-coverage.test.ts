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
  it("admin beats inferred; strong needs one candidate, ≥3 accepted, 0 rejected; everything else inferred is weak", () => {
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
        ["f6", "asserted"],
        ["x1", "strong"],
        ["x2", "weak"],
        ["x3", "weak"],
        ["x4", "asserted"],
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

  it("RPM and the registry agreeing on one iD is strong whatever the accepted counts — unless the RPM row has rejections; disagreeing is weak; admin still wins", () => {
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
        ["a3", "asserted"],
        ["a4", "weak"],
      ]),
    );
    expect(t.size).toBe(4);
  });
});

describe("buildOrcidCoverage", () => {
  it("tiles are the unfiltered population regardless of filters", () => {
    const r = build(parseOrcidCoverageParams({ nih: "none", dept: "Dept B" }));
    // Asserted: p1/f1 (Identity) + f2 (confirmed) + f6 (admin). Strong: f3. Weak: f4, f5, u1.
    // None: p2.
    const c = {
      people: 9,
      orcid: 4,
      confirmed: 1,
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
    // f2, the confirmed one, is full-time AND NIH-funded, so every tile carries it.
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

  it("dismissed (cwid, iD) pairs count nowhere: not as a candidate row, not as scholar.orcid — and only that exact pair", () => {
    // Listed f6 → f2 (anti-sorted). f6's admin iD-a is dismissed, but f3's iD-a (another cwid,
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
    // Without the dismissals the same rows are 4 asserted / 1 confirmed / 1 strong / 3 weak.
    expect(build().tiles.overall).toMatchObject({ orcid: 4, confirmed: 1, strong: 1, weak: 3 });
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

  it("an rpm_admin row → asserted with the admin iD, whatever else is there", () => {
    expect(
      orcidVerdict([cand("x", "rpm_inferred", 9, 0, "iD-b"), cand("x", "rpm_admin", 0, 0, "iD-a")]),
    ).toEqual({ tier: "asserted", orcid: "iD-a", accepted: 0 });
  });

  it("orcidTiers is exactly the verdict tier per cwid", () => {
    const rows = [cand("x", "rpm_inferred", 3), cand("y", "rpm_inferred", 1), cand("z", "rpm_admin")];
    expect([...orcidTiers(rows)]).toEqual([
      ["x", "strong"],
      ["y", "weak"],
      ["z", "asserted"],
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
      row("a7", "rpm_admin"), // typed in by an admin: not an inference
      row("gone", "orcid_email"), // not in the active population
    ];
    const population = new Set(["a1", "a2", "a3", "a4", "a5", "a6", "a7"]);
    expect(inferenceSourceCounts(candidates, population)).toEqual({
      rpmStrong: 1,
      rpmWeak: 2,
      registryEmail: 1,
      registryWorks: 1,
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
