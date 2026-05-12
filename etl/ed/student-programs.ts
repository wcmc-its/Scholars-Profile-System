/**
 * ED ETL — PhD student program records (issue #195).
 *
 * Pulls every PHD Role record from `ou=students,ou=sors` (object class
 * `weillCornellEduSORRoleRecord`), including expired rows so alumni
 * mentees resolve to their program of study. Collapses to one row per
 * CWID (active beats expired; among ties, the most recent endDate wins)
 * and truncate-rebuilds `student_phd_program`.
 *
 * Consumed by the mentoring chip subtitle in `lib/api/mentoring.ts` —
 * `programName` precedence is ED program → Jenzabar `major_desc` → null.
 *
 * Usage: `npm run etl:ed:student-programs`
 */
import { prisma } from "../../lib/db";
import {
  collapsePhdStudentProgramRecords,
  fetchPhdStudentProgramRecords,
  openLdap,
} from "@/lib/sources/ldap";

const INSERT_BATCH = 500;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const start = Date.now();
  const run = await prisma.etlRun.create({
    data: {
      id: crypto.randomUUID(),
      source: "ED-Student-Programs",
      status: "running",
    },
  });

  const client = await openLdap();
  try {
    console.log("Fetching PHD student Role records from ou=students,ou=sors...");
    const raw = await fetchPhdStudentProgramRecords(client);
    console.log(`Got ${raw.length} raw Role records.`);

    const collapsed = collapsePhdStudentProgramRecords(raw);
    console.log(`Collapsed to ${collapsed.size} distinct CWIDs.`);

    const rows = [...collapsed.values()].map((r) => ({
      cwid: r.cwid,
      program: r.program,
      programCode: r.programCode,
      expectedGradYear: r.expectedGradYear,
      status: r.status,
      exitReason: r.exitReason,
      startDate: r.startDate,
      endDate: r.endDate,
    }));

    console.log("Truncating student_phd_program...");
    await prisma.studentPhdProgram.deleteMany();

    console.log(`Inserting ${rows.length} rows...`);
    for (const batch of chunks(rows, INSERT_BATCH)) {
      await prisma.studentPhdProgram.createMany({
        data: batch,
        skipDuplicates: true,
      });
    }

    await prisma.etlRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        completedAt: new Date(),
        rowsProcessed: rows.length,
      },
    });

    const active = rows.filter((r) => r.status === "student:active").length;
    const expired = rows.length - active;
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `ED student-programs ETL complete in ${elapsed}s: rows=${rows.length} (active=${active}, expired/alumni=${expired})`,
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
    await client.unbind();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
