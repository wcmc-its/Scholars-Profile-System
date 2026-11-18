/**
 * Open authorship rows per byline ORCID iD → `orcid_open_authorship`.
 *
 * reciterdb's `authorship_review` holds candidate authorships from Scopus and
 * OpenAlex awaiting a curator. A row can carry `byline_orcid`: the iD the source
 * attaches to that byline author (CHAR(19), bare form). When a person's iD is
 * confirmed in Scholars, the open rows carrying it can be settled quickly, so
 * `/edit/orcid-coverage` shows how much review work is waiting on confirmations.
 *
 * One grouped read (`status = 'open'`, `byline_orcid` set), then a full replace
 * of the SPS table in one transaction, every row stamped with the same
 * `refreshed_at`. Counts per iD only: no cwid, no article, no name. The page
 * joins the iDs to people through `scholar.orcid` and `orcid_candidate`.
 *
 * Guards. The step never fails the nightly for a source that is not ready:
 *  - `authorship_review` or its `byline_orcid` column is absent (reciterdb v3.15
 *    not applied), or the SPS reciterdb user may not SELECT it: logged, the table
 *    is left as it is, and the run ends normally. The page hides the numbers once
 *    `refreshed_at` is 48 hours old.
 *  - An empty read never replaces a non-empty table: the step throws (yesterday's
 *    rows stay; the step is on the "continue" tier, so the nightly goes on).
 *
 * Read-only against reciterdb, and staging and prod read the same reciterdb, so
 * there is no env flag.
 *
 * Usage: `npm run etl:orcid-authorship-impact`. Runs on the sources task family
 * (needs `SCHOLARS_RECITERDB_*`).
 */
import { db } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";

const ORCID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const INSERT_BATCH = 1000;

/** One grouped source row: an iD and how many open rows carry it. */
export type SourceRow = { orcid: string | null; openRows: number | bigint | string | null };
export type OpenAuthorshipRow = { orcid: string; openRows: number };

/** Source rows → table rows: trims, upper-cases the check digit, drops malformed
 *  iDs and non-positive counts, and sums rows that normalise to the same iD. Pure. */
export function toOpenAuthorshipRows(source: readonly SourceRow[]): {
  rows: OpenAuthorshipRow[];
  invalid: number;
} {
  const byOrcid = new Map<string, number>();
  let invalid = 0;
  for (const r of source) {
    const orcid = String(r.orcid ?? "")
      .trim()
      .toUpperCase();
    const n = Number(r.openRows ?? 0);
    if (!ORCID_PATTERN.test(orcid) || !Number.isInteger(n) || n <= 0) {
      invalid++;
      continue;
    }
    byOrcid.set(orcid, (byOrcid.get(orcid) ?? 0) + n);
  }
  return { rows: [...byOrcid].map(([orcid, openRows]) => ({ orcid, openRows })), invalid };
}

/** MySQL / MariaDB errors that mean "the source is not ready for us", not an outage:
 *  no such table (1146), unknown column (1054), SELECT denied on the table (1142)
 *  or on a column (1143). */
const NOT_READY_ERRNOS: ReadonlySet<number> = new Set([1146, 1054, 1142, 1143]);

/** Why the source cannot be read yet, or null when the error is something else
 *  (an outage, a timeout) and must propagate. Pure. */
export function sourceNotReadyReason(err: unknown): string | null {
  const errno = (err as { errno?: unknown } | null)?.errno;
  if (typeof errno !== "number" || !NOT_READY_ERRNOS.has(errno)) return null;
  return errno === 1146
    ? "authorship_review does not exist"
    : errno === 1054
      ? "authorship_review has no byline_orcid column"
      : "SELECT on authorship_review is denied to the SPS reciterdb user";
}

/** What to do with a read. `skip` = nothing to write and nothing to lose; `refuse`
 *  = an empty read against a table that has rows (never wipe on a source outage). Pure. */
export function replaceDecision(incoming: number, existing: number): "replace" | "skip" | "refuse" {
  if (incoming > 0) return "replace";
  return existing > 0 ? "refuse" : "skip";
}

/** The grouped read, or the reason the source is not ready. */
async function readSource(): Promise<SourceRow[] | { notReady: string }> {
  return withReciterConnection(async (conn) => {
    try {
      // information_schema lists only columns the connected user may read, so an
      // absent table, an absent column and a missing grant all count 0 here.
      const [{ c }] = (await conn.query(
        `SELECT COUNT(*) AS c FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'authorship_review'
            AND column_name IN ('byline_orcid', 'status')`,
      )) as Array<{ c: number | bigint }>;
      if (Number(c) < 2) {
        return {
          notReady:
            "authorship_review.byline_orcid / status not visible (table or column absent, or no SELECT grant)",
        };
      }
      return (await conn.query(
        `SELECT byline_orcid AS orcid, COUNT(*) AS openRows
           FROM authorship_review
          WHERE status = 'open' AND byline_orcid IS NOT NULL AND byline_orcid <> ''
          GROUP BY byline_orcid`,
      )) as SourceRow[];
    } catch (err) {
      const notReady = sourceNotReadyReason(err);
      if (notReady === null) throw err;
      return { notReady };
    }
  });
}

async function main(): Promise<number> {
  const source = await readSource();
  if (!Array.isArray(source)) {
    console.log(
      `orcid-authorship-impact: SKIPPED (${source.notReady}); orcid_open_authorship left as it is.`,
    );
    return 0;
  }
  const { rows, invalid } = toOpenAuthorshipRows(source);
  const total = rows.reduce((n, r) => n + r.openRows, 0);
  console.log(
    `ReciterDB: ${total} open authorship rows across ${rows.length} byline ORCID iDs (${invalid} groups skipped: malformed iD or count).`,
  );

  const decision = replaceDecision(rows.length, await db.write.orcidOpenAuthorship.count());
  if (decision === "refuse") {
    // Fail loud rather than wipe: an empty read is a source outage or capture
    // switched off, not "no open row carries an iD".
    throw new Error(
      "0 open authorship rows with a byline ORCID read from ReciterDB; refusing to replace a non-empty orcid_open_authorship",
    );
  }
  if (decision === "skip") {
    console.log("orcid-authorship-impact: nothing read and nothing stored; no write.");
    return 0;
  }

  const refreshedAt = new Date();
  await db.write.$transaction(
    async (tx) => {
      await tx.orcidOpenAuthorship.deleteMany({});
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        await tx.orcidOpenAuthorship.createMany({
          data: rows.slice(i, i + INSERT_BATCH).map((r) => ({ ...r, refreshedAt })),
        });
      }
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  console.log(`orcid_open_authorship replaced: ${rows.length} iDs, ${total} open rows.`);
  return rows.length;
}

// db.write.$disconnect() in .finally, not main(): withEtlRun writes its
// success/failure row after main() returns (see etl/research-security/index.ts).
if (!process.env.VITEST) {
  withEtlRun("ORCID-authorship-impact", main)
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeReciterPool();
      await db.write.$disconnect();
    });
}
