import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  suppressionFindMany: vi.fn(),
  suppressionUpdate: vi.fn(),
  suppressionDeleteMany: vi.fn(),
  reflectGrantSuppressions: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {},
    write: {
      suppression: {
        findMany: hoisted.suppressionFindMany,
        update: hoisted.suppressionUpdate,
        deleteMany: hoisted.suppressionDeleteMany,
      },
    },
  },
  disconnect: vi.fn(),
  prisma: {},
}));

vi.mock("@/lib/edit/search-suppression", () => ({
  reflectGrantSuppressions: hoisted.reflectGrantSuppressions,
}));

import {
  dropSystemSuppressionsForDeletedGrants,
  joinAccountPeriods,
  planSuppressionRepoints,
  repointReissuedSuppressions,
} from "@/etl/infoed";

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

/**
 * #2224 — the Account_Number re-key. `external_id` is
 * `INFOED-{Account_Number}-{CWID}` and Account_Number flips from `prop_no` to
 * `parentprop_no` the moment a proposal joins a family, so the same award is
 * hard-deleted under the old id and re-created under a new one. Without the
 * re-point the curator's takedown silently becomes a no-op.
 */
describe("planSuppressionRepoints (#2224)", () => {
  const stale = (account: string, cwid: string, award: string | null) => ({
    externalId: `INFOED-${account}-${cwid}`,
    cwid,
    awardNumber: award,
  });

  it("follows the award when InfoEd re-keys prop_no -> parentprop_no", () => {
    expect(
      planSuppressionRepoints(
        [stale("111111", "abc1234", "R01AG012345")],
        [stale("900001", "abc1234", "R01AG012345")],
      ),
    ).toEqual([
      { from: "INFOED-111111-abc1234", to: "INFOED-900001-abc1234" },
    ]);
  });

  it("does not follow across investigators — the pair is (cwid, awardNumber)", () => {
    expect(
      planSuppressionRepoints(
        [stale("111111", "abc1234", "R01AG012345")],
        [stale("900001", "xyz9876", "R01AG012345")],
      ),
    ).toEqual([]);
  });

  it("leaves an award that simply left the feed orphaned, not re-pointed", () => {
    expect(
      planSuppressionRepoints([stale("111111", "abc1234", "R01AG012345")], []),
    ).toEqual([]);
  });

  it("skips a null awardNumber — nothing else identifies the award across the re-key", () => {
    expect(
      planSuppressionRepoints(
        [stale("111111", "abc1234", null)],
        [stale("900001", "abc1234", null)],
      ),
    ).toEqual([]);
  });

  it("skips an ambiguous pair rather than guess which suppression follows which id", () => {
    // One stale row, two new accounts under the same (cwid, award): a takedown
    // moved onto the wrong one is worse than the orphan.
    expect(
      planSuppressionRepoints(
        [stale("111111", "abc1234", "R01AG012345")],
        [
          stale("900001", "abc1234", "R01AG012345"),
          stale("900002", "abc1234", "R01AG012345"),
        ],
      ),
    ).toEqual([]);
    // ...and symmetrically, two stale rows collapsing into one new account.
    expect(
      planSuppressionRepoints(
        [
          stale("111111", "abc1234", "R01AG012345"),
          stale("111112", "abc1234", "R01AG012345"),
        ],
        [stale("900001", "abc1234", "R01AG012345")],
      ),
    ).toEqual([]);
  });
});

/**
 * The two lines the plan alone does not cover: which suppressions are eligible
 * to move, and what the move does to the reflection sentinel.
 */
describe("repointReissuedSuppressions (#2224)", () => {
  const OLD = "INFOED-111111-abc1234";
  const NEW = "INFOED-900001-abc1234";
  const key = (externalId: string) => ({
    externalId,
    cwid: "abc1234",
    awardNumber: "R01AG012345",
  });

  beforeEach(() => {
    hoisted.suppressionFindMany.mockReset().mockResolvedValue([]);
    hoisted.suppressionUpdate.mockReset().mockResolvedValue({});
    hoisted.reflectGrantSuppressions.mockReset().mockResolvedValue([]);
  });

  it("moves the row, resets searchReflectedAt, and reflects it", async () => {
    hoisted.suppressionFindMany.mockResolvedValue([{ id: "sup-1", entityId: OLD }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await repointReissuedSuppressions([OLD], [key(OLD)], [key(NEW)]);

    // searchReflectedAt back to NULL is load-bearing, not cosmetic: the #393
    // reconciler selects on that NULL sentinel, so a moved row that kept a
    // stale non-NULL stamp is skipped forever if the reflect below is lost.
    expect(hoisted.suppressionUpdate).toHaveBeenCalledWith({
      where: { id: "sup-1" },
      data: { entityId: NEW, searchReflectedAt: null },
    });
    expect(hoisted.reflectGrantSuppressions).toHaveBeenCalledWith([
      { suppressionId: "sup-1", entityId: NEW },
    ]);
    log.mockRestore();
  });

  it("considers only un-revoked takedowns — re-pointing a revoked one re-hides the award", async () => {
    await repointReissuedSuppressions([OLD], [key(OLD)], [key(NEW)]);

    expect(hoisted.suppressionFindMany.mock.calls[0][0].where).toEqual({
      entityType: "grant",
      revokedAt: null,
      entityId: { in: [OLD] },
    });
    expect(hoisted.suppressionUpdate).not.toHaveBeenCalled();
    expect(hoisted.reflectGrantSuppressions).not.toHaveBeenCalled();
  });
});

/**
 * #2224 follow-up — the other half of "the award simply left the feed". The
 * plan above correctly declines to re-point it; without this the auto-minted
 * takedown it leaves behind fails `etl:integrity` every night forever. Prod
 * 2026-09-03 spent a night red on exactly one such row.
 */
describe("dropSystemSuppressionsForDeletedGrants (#2224)", () => {
  const GONE = "INFOED-111111-abc1234";

  beforeEach(() => {
    hoisted.suppressionDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  });

  it("deletes only the ETL's own un-revoked takedowns, and only on the stale ids", async () => {
    await dropSystemSuppressionsForDeletedGrants([GONE]);

    // Every clause is load-bearing. Without `createdBy` this silently voids a
    // curator's takedown, which is the failure #2224 exists to catch; without
    // `revokedAt` it deletes a human's "not actually confidential" tombstone,
    // and `reconcileConfidentialTitles` (which dedupes on entityId across
    // revoked rows) then re-hides the award the next time it appears.
    expect(hoisted.suppressionDeleteMany).toHaveBeenCalledWith({
      where: {
        entityType: "grant",
        createdBy: "system-confidential-title",
        revokedAt: null,
        entityId: { in: [GONE] },
      },
    });
  });

  it("touches nothing when the run pruned no grants", async () => {
    await dropSystemSuppressionsForDeletedGrants([]);

    expect(hoisted.suppressionDeleteMany).not.toHaveBeenCalled();
  });
});

/**
 * Wiring. A mutation run deleted each call below and left the suite green: the
 * helpers are well pinned, but nothing asserted they are ever CALLED, so
 * reverting the whole delivered payload cost nothing. Source-text assertions,
 * because both call sites live inside `main()` — which opens MSSQL. Comments
 * are stripped first, same as `tests/unit/etl-disconnect-guard.test.ts`:
 * without that these catch a deleted call but not a commented-out one.
 */
describe("the grant-suppression call sites are wired into the InfoEd ETL", () => {
  const INFOED = readFileSync(join(process.cwd(), "etl/infoed/index.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("InfoEd main() re-points reissued suppressions (#2224)", () => {
    expect(INFOED).toMatch(
      /await repointReissuedSuppressions\(\s*plan\.staleExternalIds,\s*existingGrants,\s*plan\.toCreate,?\s*\)/,
    );
  });

  it("InfoEd main() drops the auto-minted takedowns of pruned grants (#2224)", () => {
    // Ordering is the assertion: run BEFORE the re-point and this deletes the
    // rows the re-point was about to move onto the reissued id.
    expect(INFOED).toMatch(
      /await repointReissuedSuppressions\([\s\S]*?\)\s*;\s*await dropSystemSuppressionsForDeletedGrants\(\s*plan\.staleExternalIds,?\s*\)/,
    );
  });

  it("the InfoEd confidential-title net reflects what it mints (#2284)", () => {
    expect(INFOED).toContain("await reflectGrantSuppressions(minted)");
  });
});
