/**
 * Jenzabar ETL — Graduate School faculty appointments (issue #193).
 *
 * Pulls from `TmsEPly.dbo.WCN_vw_GS_Faculty_LR` and writes one
 * `Appointment` row per faculty under source `JENZABAR-GSFACULTY`.
 *
 * Scope (intentionally narrow — see discovery writeup
 *  `docs/etl/jenzabar-gs-faculty-probe.md`):
 *   - One row per CWID. The view's secondary/tertiary PhD slots and the
 *     second MS slot are not surfaced — only the faculty's primary GS
 *     program is imported.
 *   - "Primary program" = `PRIMARY PHD AFFILIATION` if non-null, else
 *     `MS AFFILIATION 1` if non-null, else the row is skipped.
 *   - Active filter: `WCGS FACULTY STATUS = 'Y'`. Rows with N or null
 *     are excluded at the SQL level so the result set stays small.
 *   - Missing scholar (CWID not in `Scholar` or soft-deleted) → row
 *     skipped with a logged warning. Same precedent as the NYP affiliate
 *     branch in `etl/ed/index.ts:874-880`.
 *   - All rows written with `isPrimary: false`. WCM College appointment
 *     remains the institutionally-primary slot.
 *
 * Permission caveat: the `IDM_JZBR` principal has SELECT denied on
 * column `Degree_Code`. The query enumerates only the columns we need.
 *
 * Idempotent: every run wipes `Appointment` rows with source
 * `JENZABAR-GSFACULTY` and re-inserts the current set. Faculty no
 * longer in the view (or no longer WCGS-active) lose their row on the
 * next run.
 *
 * Usage: `npm run etl:jenzabar:import-gs-faculty`
 */
import { prisma } from "../../lib/db";
import { closeJenzabarPool, getJenzabarPool } from "@/lib/sources/mssql-jenzabar";

const VIEW = "[TmsEPly].[dbo].[WCN_vw_GS_Faculty_LR]";
const SOURCE = "JENZABAR-GSFACULTY";
const SCHOOL_LABEL = "Weill Cornell Graduate School";
const INSERT_BATCH = 500;

type GsFacultyRow = {
  JID: number;
  CWID: string | null;
  INSTRUCTOR_TYPE: string | null;
  WCGS_FACULTY_STATUS: string | null;
  PRIMARY_PHD_AFFILIATION: string | null;
  PRIMARY_PHD_APPOINTMENT_DATE: string | null;
  MS_AFFILIATION_1: string | null;
  MS_APPOINTMENT_DATE_1: Date | null;
};

function trim(s: string | null): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t === "" ? null : t;
}

/** PhD-date columns are `nvarchar` strings shaped "M/D/YYYY" (or M/D/YY).
 *  MS-date columns are proper `datetime`. Returns null when the value
 *  is missing or unparseable. */
function parseAppointmentDate(raw: string | Date | null | undefined): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(trimmed);
  if (!m) return null;
  const mo = m[1].padStart(2, "0");
  const day = m[2].padStart(2, "0");
  let year = m[3];
  if (year.length === 2) year = (Number(year) >= 50 ? "19" : "20") + year;
  const dt = new Date(`${year}-${mo}-${day}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const start = Date.now();
  const run = await prisma.etlRun.create({
    data: { id: crypto.randomUUID(), source: "Jenzabar-GS-Faculty", status: "running" },
  });

  try {
    console.log(`Querying ${VIEW} for active Grad School faculty...`);
    const pool = await getJenzabarPool();
    const result = await pool.request().query<GsFacultyRow>(`
      SELECT
        JID,
        CWID,
        [INSTRUCTOR TYPE]              AS INSTRUCTOR_TYPE,
        [WCGS FACULTY STATUS]          AS WCGS_FACULTY_STATUS,
        [PRIMARY PHD AFFILIATION]      AS PRIMARY_PHD_AFFILIATION,
        [PRIMARY PhD APPOINTMENT DATE] AS PRIMARY_PHD_APPOINTMENT_DATE,
        [MS AFFILIATION 1]             AS MS_AFFILIATION_1,
        [MS APPOINTMENT DATE 1]        AS MS_APPOINTMENT_DATE_1
      FROM ${VIEW}
      WHERE [WCGS FACULTY STATUS] = 'Y'
        AND CWID IS NOT NULL AND CWID <> ''
    `);
    const rows = result.recordset;
    console.log(`Got ${rows.length} active WCGS faculty rows with CWID.`);

    // Build candidate inserts in-memory, gated on having a primary program.
    type Candidate = {
      cwid: string;
      jid: number;
      title: string;
      program: string;
      startDate: Date | null;
    };

    const candidates: Candidate[] = [];
    let skippedNoProgram = 0;
    let skippedNoTitle = 0;
    for (const r of rows) {
      const cwid = trim(r.CWID);
      if (!cwid) continue;

      // Primary program: PhD wins over MS when both are populated.
      const phdProgram = trim(r.PRIMARY_PHD_AFFILIATION);
      const msProgram = trim(r.MS_AFFILIATION_1);
      const program = phdProgram ?? msProgram ?? null;
      if (!program) {
        skippedNoProgram += 1;
        continue;
      }

      // Title is NOT NULL in the Appointment schema; skip rows where the
      // source carries no rank rather than fabricating one.
      const title = trim(r.INSTRUCTOR_TYPE);
      if (!title) {
        skippedNoTitle += 1;
        continue;
      }

      // Date matches the program source: PhD date string for PhD program,
      // MS datetime for MS program.
      const startDate = phdProgram
        ? parseAppointmentDate(r.PRIMARY_PHD_APPOINTMENT_DATE)
        : parseAppointmentDate(r.MS_APPOINTMENT_DATE_1);

      candidates.push({
        cwid,
        jid: r.JID,
        title,
        program,
        startDate,
      });
    }
    console.log(
      `Candidates with primary program + title: ${candidates.length} ` +
        `(skipped ${skippedNoProgram} no-program, ${skippedNoTitle} no-title).`,
    );

    // Filter to scholars present in our system (skip-missing-scholar policy
    // matches etl/ed/index.ts:874-880 for the NYP branch). This naturally
    // excludes MSK/Rockefeller/HSS home faculty who have no Scholar row.
    const candidateCwids = [...new Set(candidates.map((c) => c.cwid))];
    const knownScholars = new Set(
      (
        await prisma.scholar.findMany({
          where: {
            cwid: { in: candidateCwids },
            deletedAt: null,
            status: "active",
          },
          select: { cwid: true },
        })
      ).map((s) => s.cwid),
    );
    const skippedNoScholar = candidates.filter((c) => !knownScholars.has(c.cwid));
    if (skippedNoScholar.length > 0) {
      const sample = skippedNoScholar.slice(0, 5).map((c) => c.cwid).join(", ");
      console.warn(
        `[Jenzabar-GS-Faculty] skipping ${skippedNoScholar.length} CWIDs with no active ` +
          `Scholar row (e.g. ${sample}${skippedNoScholar.length > 5 ? ", ..." : ""}).`,
      );
    }
    const importable = candidates.filter((c) => knownScholars.has(c.cwid));
    console.log(`Importable rows after scholar match: ${importable.length}.`);

    // Build Appointment inserts.
    const inserts = importable.map((c) => ({
      id: crypto.randomUUID(),
      cwid: c.cwid,
      title: c.title,
      organization: `${SCHOOL_LABEL} — ${c.program}`,
      startDate: c.startDate,
      endDate: null,
      isPrimary: false,
      isInterim: false,
      externalId: `${SOURCE}-${c.jid}`,
      source: SOURCE,
    }));

    // Hard delete-and-replace under the JENZABAR-GSFACULTY source. ED-source
    // and NYP-source rows untouched.
    console.log(`Deleting existing ${SOURCE} appointments...`);
    const deleted = await prisma.appointment.deleteMany({ where: { source: SOURCE } });
    console.log(`Deleted ${deleted.count} stale rows.`);

    console.log(`Inserting ${inserts.length} fresh rows...`);
    let inserted = 0;
    for (const batch of chunks(inserts, INSERT_BATCH)) {
      const res = await prisma.appointment.createMany({
        data: batch,
        skipDuplicates: true,
      });
      inserted += res.count;
    }

    await prisma.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: inserted },
    });

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `Jenzabar GS Faculty ETL complete in ${elapsed}s: deleted=${deleted.count} inserted=${inserted}.`,
    );
  } catch (err) {
    await prisma.etlRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  } finally {
    await closeJenzabarPool();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
