import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { joinAccountPeriods } from "@/etl/infoed";

/**
 * #2173 — the account-level project period used to be a `LEFT JOIN (...) AS
 * acct ON acct.Account_Number = v.Account_Number` inside CONSOLIDATED_QUERY.
 * The join key was a CASE expression that was also the GROUP BY key, so SQL
 * Server could not seek it; measured against InfoEd prod 2026-08-05 the
 * consolidated query ran 338.5s WITHOUT it and blew the 2,400,000ms
 * requestTimeout WITH it. It is now a second query joined here.
 *
 * These assert the TS join is the same RELATION the SQL LEFT JOIN was.
 */
const base = {
  CWID: "abc1234",
  Award_Number: "R01AG012345",
  proj_title: "t",
  unit_name: null,
  int_unit_code: null,
  program_type: null,
  Orig_Sponsor: null,
  Subward_Sponsor: null,
  spon_code: null,
  Role: "PrincipalInvestigatorRole",
  Project_Status: "Active Award",
};
const row = (Account_Number: string) => ({ ...base, Account_Number });
const period = (Account_Number: string, b: string | null, e: string | null) => ({
  Account_Number,
  begin_date: b === null ? null : new Date(b),
  end_date: e === null ? null : new Date(e),
});

describe("joinAccountPeriods (#2173)", () => {
  it("attaches the matching account's period", () => {
    const out = joinAccountPeriods(
      [row("A1")],
      [period("A1", "2024-01-01", "2027-12-31")],
    );
    expect(out).toHaveLength(1);
    expect(out[0].begin_date).toEqual(new Date("2024-01-01"));
    expect(out[0].end_date).toEqual(new Date("2027-12-31"));
  });

  it("is a LEFT join — an account with no period row keeps NULL dates, not a dropped row", () => {
    const out = joinAccountPeriods([row("A1"), row("A2")], [period("A2", "2024-01-01", "2025-01-01")]);
    expect(out).toHaveLength(2); // <- the row survives; an INNER join would lose it
    expect(out[0].begin_date).toBeNull();
    expect(out[0].end_date).toBeNull();
    expect(out[1].begin_date).toEqual(new Date("2024-01-01"));
  });

  it("shares one account's period across every CWID on it (the whole point of #2173)", () => {
    // Two people on the same account must both see the account's dates, which
    // the old per-(cwid, account) aggregate could not do for a CWID hanging
    // off a dateless child/amendment.
    const out = joinAccountPeriods(
      [{ ...row("A1"), CWID: "aaa1111" }, { ...row("A1"), CWID: "bbb2222" }],
      [period("A1", "2024-01-01", "2027-12-31")],
    );
    expect(out.map((r) => r.begin_date)).toEqual([
      new Date("2024-01-01"),
      new Date("2024-01-01"),
    ]);
  });

  it("carries a half-open period through as-is (NULL begin or end is meaningful)", () => {
    const out = joinAccountPeriods([row("A1")], [period("A1", null, "2027-12-31")]);
    expect(out[0].begin_date).toBeNull();
    expect(out[0].end_date).toEqual(new Date("2027-12-31"));
  });

  it("preserves every non-period field untouched", () => {
    const out = joinAccountPeriods([row("A1")], [period("A1", "2024-01-01", "2025-01-01")]);
    const { begin_date, end_date, ...rest } = out[0];
    expect(rest).toEqual(row("A1"));
    expect(begin_date).not.toBeNull();
    expect(end_date).not.toBeNull();
  });

  it("returns an empty result for empty input, not a throw", () => {
    expect(joinAccountPeriods([], [period("A1", "2024-01-01", "2025-01-01")])).toEqual([]);
  });
});

/**
 * The SQL body must stay byte-equivalent to the derived table it replaced —
 * the refactor's whole safety argument is "same rows, different placement".
 */
describe("ACCOUNT_PERIOD_QUERY shape", () => {
  const SRC = readFileSync(
    join(process.cwd(), "etl/infoed/index.ts"),
    "utf8",
  );

  it("groups by Account_Number, which is what makes the Map join exact", () => {
    const m = SRC.match(/const ACCOUNT_PERIOD_QUERY = `\n([\s\S]*?)\n`;/);
    expect(m).not.toBeNull();
    const sql = m![1];
    expect(sql).toMatch(
      /GROUP BY CASE WHEN p\.parentprop_no IS NULL THEN p\.prop_no ELSE p\.parentprop_no END/,
    );
    expect(sql).toMatch(/MIN\(p\.app_st_dt\)\s+AS begin_date/);
    expect(sql).toMatch(/MAX\(p\.app_end_dt\)\s+AS end_date/);
  });

  it("keeps all four scope predicates — dropping one changes which rows get dates", () => {
    const sql = SRC.match(/const ACCOUNT_PERIOD_QUERY = `\n([\s\S]*?)\n`;/)![1];
    expect(sql).toContain("p.system = 'PT'");
    expect(sql).toContain("p.inst_code = 'WCORNELLMC'");
    expect(sql).toContain("psub.child IS NULL");
    expect(sql).toContain("pcd.code_desc IN ('Active Award', 'Expired Award', 'In Process')");
    expect(sql).toContain("ISNULL(pu.p_log_50, 0) <> 1");
  });

  it("no longer embeds the account period as a derived table in CONSOLIDATED_QUERY", () => {
    const consolidated = SRC.match(/const CONSOLIDATED_QUERY = `\n([\s\S]*?)\n`;/)![1];
    expect(consolidated).not.toContain("AS acct");
    expect(consolidated).not.toContain("acct.begin_date");
  });
});
