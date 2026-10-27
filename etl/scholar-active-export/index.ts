/**
 * Scholars' active people → reciterdb `scholar_active`, for Publication Manager.
 *
 * Scholars is the ORCID authority for everyone with an active record
 * (Roadmap/orcid-scholars-authority-plan.md, SPS PR 3). PM reads this table to
 * decide whether its ORCID field is read-only, with a "Change in Scholars" link.
 * It holds no iD: PM shows the one in WCM Identity, which `etl/orcid-push` keeps
 * equal to `scholar.orcid`, and `has_confirmed_orcid = 0` tells PM to label that
 * value "not confirmed in Scholars" (Identity can still hold an iD Scholars has
 * not confirmed).
 *
 * One row per non-deleted scholar, the set `etl/orcid-push` writes Identity for:
 *   cwid, has_confirmed_orcid (`orcid` set AND `orcid_confirmed_at` set), refreshed_at.
 * Every row of a run carries the same `refreshed_at`; PM treats the table as
 * missing when MAX(refreshed_at) is older than its threshold (48 h).
 *
 * Write: DELETE + INSERT in one transaction, so a reader sees the old set or the
 * new one, never half. Grants needed on reciterdb: SELECT, INSERT, DELETE on
 * `scholar_active` (table DDL: ReCiterDB setup/table_scholar_active_v3.1.sql).
 *
 * Guards:
 *   - Prod only. Staging and prod share one reciterdb, so a staging run would
 *     overwrite prod's set with staging's. Any other `SCHOLARS_ENV` is a dry run.
 *   - Refuses an empty set, and a set that shrinks by more than
 *     MAX_SHRINK of the rows already there (a truncated scholar read is an
 *     outage, not a mass departure). `--force` overrides the shrink guard.
 *
 * Usage: `npm run etl:scholar-active-export` [-- --dry-run] [-- --force]
 * Needs `SCHOLARS_RECITERDB_*` (the sources task family).
 */
import { db } from "../../lib/db";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import { withEtlRun } from "@/lib/etl-run";

export const TABLE = "scholar_active";
/** ponytail: a fixed 10% bound; make it a flag if a real re-org ever trips it. */
export const MAX_SHRINK = 0.1;
const BATCH = 1000;

export type ActiveRow = { cwid: string; hasConfirmedOrcid: boolean };

/** Pure: the shrink guard. Null when the write may go ahead, else the reason. */
export function refuseReason(next: number, current: number, force: boolean): string | null {
  if (next === 0) return "0 active scholars read — refusing to empty the table";
  if (!force && current > 0 && next < current * (1 - MAX_SHRINK))
    return `active set shrank from ${current} to ${next} (more than ${MAX_SHRINK * 100}%) — rerun with --force if real`;
  return null;
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run") || process.env.SCHOLARS_ENV !== "prod";
  const force = process.argv.includes("--force");
  const rows: ActiveRow[] = (
    await db.write.scholar.findMany({
      where: { deletedAt: null },
      select: { cwid: true, orcid: true, orcidConfirmedAt: true },
      orderBy: { cwid: "asc" },
    })
  ).map((s) => ({
    cwid: s.cwid.toLowerCase(),
    hasConfirmedOrcid: s.orcid !== null && s.orcidConfirmedAt !== null,
  }));
  const confirmed = rows.filter((r) => r.hasConfirmedOrcid).length;
  console.log(`${rows.length} active scholar(s), ${confirmed} with a confirmed ORCID iD.`);

  return withReciterConnection(async (conn) => {
    const [{ n }] = (await conn.query(`SELECT COUNT(*) AS n FROM ${TABLE}`)) as Array<{
      n: number;
    }>;
    const refused = refuseReason(rows.length, Number(n), force);
    if (refused) throw new Error(refused);
    if (dryRun) {
      console.log(
        `Dry run (SCHOLARS_ENV=${process.env.SCHOLARS_ENV ?? "unset"}): would replace ${n} row(s) with ${rows.length}. Only prod writes.`,
      );
      return 0;
    }
    const now = new Date();
    await conn.beginTransaction();
    try {
      await conn.query(`DELETE FROM ${TABLE}`);
      for (let i = 0; i < rows.length; i += BATCH) {
        await conn.batch(
          `INSERT INTO ${TABLE} (cwid, has_confirmed_orcid, refreshed_at) VALUES (?, ?, ?)`,
          rows.slice(i, i + BATCH).map((r) => [r.cwid, r.hasConfirmedOrcid ? 1 : 0, now]),
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
    console.log(`${TABLE}: replaced ${n} row(s) with ${rows.length}.`);
    return rows.length;
  });
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  withEtlRun("Scholar-active-export", main)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await db.write.$disconnect();
      await closeReciterPool();
    });
}
