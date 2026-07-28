/**
 * #2020 — the OSRA-facing worklist: InfoEd awards with no project period.
 *
 * Writes CSV to stdout. Redirect it to a file and attach it to an email —
 * deliberately not an S3 pipeline or a dashboard, because the artifact is a
 * spreadsheet somebody opens once a month.
 *
 * Usage:
 *   npx tsx scripts/report-grant-date-gaps.ts            # open + backfilled
 *   npx tsx scripts/report-grant-date-gaps.ts --all      # include resolved/dismissed
 *   npx tsx scripts/report-grant-date-gaps.ts --active   # active awards only
 *
 * `backfilled` rows ARE included by default and that is intentional: the grant
 * renders off a RePORTER-derived period, but the InfoEd record is still wrong
 * and only OSRA can fix it. Excluding them would hide the problem from the only
 * people who can solve it.
 */
import { db, disconnect } from "../lib/db";
import { daysOpen, toCsv, type GapReportRow, type GapStatus } from "../lib/grant-date-gap";

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const ACTIVE_ONLY = args.includes("--active");

async function main(): Promise<void> {
  const now = new Date();
  const gaps = await db.write.grantDateGap.findMany({
    where: {
      ...(ALL ? {} : { status: { in: ["open", "backfilled"] } }),
      ...(ACTIVE_ONLY ? { projectStatus: "Active Award" } : {}),
    },
    include: { scholar: { select: { preferredName: true } } },
  });

  const rows: GapReportRow[] = gaps.map((g) => ({
    cwid: g.cwid,
    scholarName: g.scholar.preferredName,
    accountNumber: g.accountNumber,
    awardNumber: g.awardNumber,
    title: g.title,
    sponsor: g.sponsor,
    projectStatus: g.projectStatus,
    programType: g.programType,
    unitName: g.unitName,
    missingField: g.missingField,
    status: g.status as GapStatus,
    backfillSource: g.backfillSource,
    firstSeenAt: g.firstSeenAt,
    daysOpen: daysOpen(g.firstSeenAt, now),
  }));

  process.stdout.write(toCsv(rows) + "\n");
  // stderr so it never lands in the CSV when stdout is redirected.
  console.error(`[grant-date-gaps] ${rows.length} rows.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(disconnect);
