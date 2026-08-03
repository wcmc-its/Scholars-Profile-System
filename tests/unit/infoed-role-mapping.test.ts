import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The InfoEd ETL's role CASE lives in a SQL string that runs on MSSQL, so it
 * can't be exercised in-process (and importing the module would run `main()`).
 * These read the shipped source text instead — enough to catch the two ways
 * this mapping has actually broken.
 */
const SRC = readFileSync(
  join(process.cwd(), "etl/infoed/index.ts"),
  "utf8",
);

/** The outer CASE that produces the `Role` column. */
function outerRoleCase(): string {
  const m = SRC.match(/\n  CASE\n([\s\S]*?)\n  END AS Role\n/);
  if (!m) throw new Error("outer Role CASE not found — did the query change?");
  return m[1];
}

describe("InfoEd role mapping", () => {
  it("emits only literals ROLE_MAP knows", () => {
    const emitted = [...outerRoleCase().matchAll(/'([A-Za-z]+Role)'/g)].map(
      (m) => m[1],
    );
    expect(emitted.length).toBeGreaterThan(0);

    const mapped = [
      ...SRC.matchAll(/^ {2}([A-Za-z]+Role): "/gm),
    ].map((m) => m[1]);

    // An unmapped literal hits `ROLE_MAP[r.Role] ?? "Key Personnel"` and is
    // published as Key Personnel with no error — invisible until someone
    // notices their PI role is gone.
    expect(new Set(mapped)).toEqual(new Set(emitted));
  });

  it("classifies a non-contact PD/PI as Co-PI on direct awards, not just subawards", () => {
    const branch = outerRoleCase()
      .split("\n")
      .find((l) => l.includes("'CoPrincipalInvestigatorRole'"));
    expect(branch).toBeDefined();

    // Regression guard: this branch used to carry `Sponsor <> Orig_Sponsor`,
    // which restricted it to subawards. An NIH multiple-PI on a direct award
    // then missed every branch and fell through to ELSE -> Key Personnel.
    expect(branch).not.toMatch(/Sponsor\s*<>\s*z\.Orig_Sponsor/);
    expect(branch).toMatch(/Any_Pd_Pi = 1/);
  });

  it("does not let an alphabetical MIN() outvote a PD/PI category", () => {
    // The arithmetic the old aggregate got wrong. MIN() over Role_Category is
    // alphabetical, so 'PI' survived only as a person's SOLE category on the
    // account; one co-investigator or key-personnel row anywhere under the same
    // PARENT proposal silently demoted a non-contact PD/PI. Measured against
    // InfoEd prod 2026-07-30: 121 (cwid, Account_Number) pairs.
    expect(["Co-Investigator", "PI"].sort()[0]).toBe("Co-Investigator");
    expect(["Key Personnel", "PI"].sort()[0]).toBe("Key Personnel");

    // So the Co-PI branch must not key off the MIN()'d column at all.
    const branch = outerRoleCase()
      .split("\n")
      .find((l) => l.includes("'CoPrincipalInvestigatorRole'"));
    expect(branch).not.toMatch(/Role_Category/);

    // ...and the aggregate it does key off must exist, testing role_category
    // EXACTLY -- a LIKE/prefix here would sweep in 'PI Subaward'/'PI Subproject',
    // which are deliberately NOT PD/PI.
    expect(SRC).toMatch(
      /MAX\(CASE WHEN role_category = 'PI' THEN 1 ELSE 0 END\) AS Any_Pd_Pi/,
    );
  });

  it("still routes a contact PI through the Primary_PI_Flag arms first", () => {
    // Any_Pd_Pi is set by first_pd = '1' too (see the CTE's Role_Category CASE),
    // so it would relabel contact PIs as MPI if it were ever reordered above
    // them. The two Primary_PI_Flag arms must stay first.
    const lines = outerRoleCase().split("\n");
    const lastFlagArm = lines.reduce(
      (acc, l, i) => (l.includes("z.Primary_PI_Flag = 'Y'") ? i : acc),
      -1,
    );
    const coPi = lines.findIndex((l) =>
      l.includes("'CoPrincipalInvestigatorRole'"),
    );
    expect(lastFlagArm).toBeGreaterThanOrEqual(0);
    expect(coPi).toBeGreaterThan(lastFlagArm);
  });

  it("keeps the Co-I branch reachable after the Co-PI branch", () => {
    const lines = outerRoleCase().split("\n");
    const coPi = lines.findIndex((l) =>
      l.includes("'CoPrincipalInvestigatorRole'"),
    );
    const coI = lines.findIndex((l) => l.includes("'CoInvestigatorRole'"));
    expect(coPi).toBeGreaterThanOrEqual(0);
    expect(coI).toBeGreaterThan(coPi);

    // The Co-PI branch matches `LIKE '%PI'`, which the Co-I branch's own
    // category ('Co-Investigator') must not satisfy, or widening the Co-PI
    // branch would have swallowed every co-investigator.
    expect("Co-Investigator".endsWith("PI")).toBe(false);
  });

  // #2173 — the project period must come from an ACCOUNT-level aggregate over
  // dbo.proposal, never from a per-CWID one. Re-keying this subquery on cwid
  // (or re-pointing it at infoed_all, which is already personnel-filtered)
  // reinstates the exact bug: a CWID attached only to a dateless
  // child/amendment stops seeing the parent proposal's real dates. That is
  // invisible to tsc, to every mock, and to the prune guard.
  it("derives begin_date/end_date from an account-level proposal aggregate", () => {
    const end = SRC.indexOf(") AS acct");
    expect(end).toBeGreaterThan(0);
    const sub = SRC.slice(SRC.lastIndexOf("LEFT JOIN (", end), end);
    const acct = SRC.slice(SRC.lastIndexOf("LEFT JOIN (", end), end + 120);

    expect(sub).toMatch(/FROM\s+wc_infoedprod\.dbo\.proposal\s+AS p\b/i);
    expect(sub).not.toMatch(/infoed_all/i);
    // No personnel/faculty join may narrow the date source.
    expect(sub).not.toMatch(/proppds|faculty/i);
    // Grouped by the account key alone — a cwid in the GROUP BY is the bug.
    expect(sub).toMatch(/GROUP BY CASE WHEN p\.parentprop_no IS NULL/i);
    expect(sub.slice(sub.indexOf("GROUP BY"))).not.toMatch(/\bcwid\b/i);
    // Joined on the account only.
    expect(acct).toMatch(
      /\)\s+AS acct\s+ON acct\.Account_Number = v\.Account_Number/i,
    );
    // Flat MIN/MAX: a parent-preference tie-break narrows live periods, and
    // choosing start and end independently can emit start > end.
    expect(sub).toMatch(/MIN\(p\.app_st_dt\)\s+AS begin_date/i);
    expect(sub).toMatch(/MAX\(p\.app_end_dt\)\s+AS end_date/i);

    // The old per-CWID date aggregate is gone for good.
    expect(SRC).not.toMatch(/MIN\(Project_Period_Start\)/i);
    expect(SRC).not.toMatch(/MAX\(Project_Period_End\)/i);
  });
});
