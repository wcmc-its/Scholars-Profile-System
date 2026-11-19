/**
 * ASMS ETL — Phase 4c. Education and training records.
 *
 * Pulls degrees from `asms.dbo.wcmc_person_school` joined with
 * `wcmc_person`, `wcmc_school`, and `wcmc_school_degree`. Filtered to
 * currently-active scholars (joined by cwid).
 *
 * Strategy:
 *   1. Read active CWIDs from local DB
 *   2. Batched IN-clause query against ASMS for education rows
 *   3. Reconcile the education table by externalId (create new / update
 *      changed / tombstone stale) — each row keeps its uuid PK across runs (#352)
 *
 * MSSQL note: the `mssql` driver doesn't have native array-IN binding, so we
 * generate parameter placeholders dynamically (@p0,@p1,...). Batch size 500
 * keeps us well under MSSQL's 2100-parameter ceiling.
 *
 * Usage: `npm run etl:asms`
 */
import { db } from "../../lib/db";
import { assertPruneVolume } from "../../lib/etl-guard";
import { closeAsmsPool, getAsmsPool } from "@/lib/sources/mssql-asms";
import { classifyByExternalId } from "@/lib/etl/reconcile";

type EducationRow = {
  cwid: string;
  degree: string | null;
  institution: string | null;
  year: number | null;
  field: string | null;
  asms_school_id: number; // for externalId / dedup
};

type TrainingRow = {
  cwid: string;
  type: string;
  institution: string | null;
  specialty: string | null;
  year_from: number | null;
  year_to: number | null;
  asms_training_id: number;
};

// ASMS `fc_doctoral_training_type` titles we show. "Other" and untyped rows are
// left out by decision (2026-11-19).
const TRAINING_TYPES = [
  "Internship",
  "Residency",
  "Fellowship",
  "Postdoctoral",
  "Internship and Residency",
];

const IN_BATCH = 500;
const INSERT_BATCH = 1000;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const start = Date.now();
  const run = await db.write.etlRun.create({
    data: { source: "ASMS", status: "running" },
  });

  try {
    console.log("Loading active CWIDs from local DB...");
    const ourScholars = await db.write.scholar.findMany({
      where: { deletedAt: null, status: "active" },
      select: { cwid: true },
    });
    const cwidList = ourScholars.map((s) => s.cwid);
    const ourCwidSet = new Set(cwidList);
    console.log(`Querying ASMS for education of ${cwidList.length} active CWIDs...`);

    const pool = await getAsmsPool();
    const educationRows: EducationRow[] = [];

    for (const batch of chunks(cwidList, IN_BATCH)) {
      const placeholders = batch.map((_, i) => `@p${i}`).join(",");
      const req = pool.request();
      batch.forEach((c, i) => req.input(`p${i}`, c));
      const result = await req.query(`
        SELECT
          p.cwid          AS cwid,
          n.title         AS degree,
          c.title         AS institution,
          s.grad_year     AS year,
          s.degree_field  AS field,
          s.id            AS asms_school_id
        FROM asms.dbo.wcmc_person_school s
        JOIN asms.dbo.wcmc_person         p ON p.id = s.person_id
        LEFT JOIN asms.dbo.wcmc_school_degree n ON n.id = s.degree_id
        LEFT JOIN asms.dbo.wcmc_school        c ON c.id = s.school_id
        WHERE p.cwid IN (${placeholders})
          AND s.grad_year IS NOT NULL
      `);
      educationRows.push(...(result.recordset as EducationRow[]));
    }

    console.log(`Got ${educationRows.length} education rows.`);

    const inserts = educationRows
      .filter((r) => ourCwidSet.has(r.cwid))
      .map((r) => ({
        cwid: r.cwid,
        degree: r.degree ?? "(unspecified degree)",
        institution: r.institution ?? "(unspecified institution)",
        year: r.year,
        field: r.field,
        externalId: `ASMS-${r.asms_school_id}`,
        source: "ASMS",
      }));

    // Issue #352 — reconcile education rows by externalId
    // (ASMS-{wcmc_person_school.id}) instead of truncating the whole table, so
    // each row keeps its uuid PK across runs for the manual-override layer
    // (ADR-005).
    const existingEducation = await db.write.education.findMany({
      where: { source: "ASMS" },
      select: {
        externalId: true, cwid: true, degree: true, institution: true,
        year: true, field: true, source: true,
      },
    });
    const plan = classifyByExternalId({
      incoming: inserts,
      existing: existingEducation,
      contentKey: (e) =>
        JSON.stringify([
          e.cwid, e.degree, e.institution, e.year, e.field, e.source,
        ]),
    });
    if (plan.duplicateExternalIds.length > 0) {
      console.warn(
        `[ASMS] ${plan.duplicateExternalIds.length} duplicate externalId(s) in ` +
          `source rows — last occurrence wins: ${plan.duplicateExternalIds
            .slice(0, 10)
            .join(", ")}`,
      );
    }

    console.log(
      `Reconciling education: ${plan.toCreate.length} new, ${plan.toUpdate.length} ` +
        `changed, ${plan.staleExternalIds.length} stale...`,
    );
    for (const batch of chunks(plan.toCreate, INSERT_BATCH)) {
      await db.write.education.createMany({ data: batch });
    }
    for (const e of plan.toUpdate) {
      await db.write.education.update({
        where: { externalId: e.externalId },
        data: { ...e, lastRefreshedAt: new Date() },
      });
    }
    // Same shape as the InfoEd stale-grant guard: a truncated-but-successful
    // source read would tombstone every missing education row at once.
    assertPruneVolume("asms:stale-education", {
      pruning: plan.staleExternalIds.length,
      of: await db.write.education.count({ where: { source: "ASMS" } }),
      maxPct: 10,
    });
    let tombstoned = 0;
    if (plan.staleExternalIds.length > 0) {
      tombstoned = (
        await db.write.education.deleteMany({
          where: { source: "ASMS", externalId: { in: plan.staleExternalIds } },
        })
      ).count;
    }
    console.log(
      `Education reconcile complete: +${plan.toCreate.length} ~${plan.toUpdate.length} -${tombstoned}`,
    );

    // Postgraduate training — `fc_doctoral_training`, same reconcile shape as
    // education above, keyed `ASMS-TRAIN-{id}`.
    const trainingRows: TrainingRow[] = [];
    const typeList = TRAINING_TYPES.map((_, i) => `@t${i}`).join(",");
    for (const batch of chunks(cwidList, IN_BATCH)) {
      const placeholders = batch.map((_, i) => `@p${i}`).join(",");
      const req = pool.request();
      batch.forEach((c, i) => req.input(`p${i}`, c));
      TRAINING_TYPES.forEach((t, i) => req.input(`t${i}`, t));
      const result = await req.query(`
        SELECT
          p.cwid        AS cwid,
          y.title       AS type,
          t.institution AS institution,
          t.specialty   AS specialty,
          t.year_from   AS year_from,
          t.year_to     AS year_to,
          t.id          AS asms_training_id
        FROM asms.dbo.fc_doctoral_training t
        JOIN asms.dbo.wcmc_person              p ON p.id = t.person_id
        JOIN asms.dbo.fc_doctoral_training_type y ON y.id = t.doctoral_training_type_id
        WHERE p.cwid IN (${placeholders})
          AND y.title IN (${typeList})
      `);
      trainingRows.push(...(result.recordset as TrainingRow[]));
    }
    const trainingInserts = trainingRows
      .filter((r) => ourCwidSet.has(r.cwid) && r.institution?.trim())
      .map((r) => ({
        cwid: r.cwid,
        type: r.type,
        institution: r.institution!.trim(),
        specialty: r.specialty?.trim() || null,
        yearFrom: r.year_from,
        yearTo: r.year_to,
        externalId: `ASMS-TRAIN-${r.asms_training_id}`,
        source: "ASMS",
      }));
    const existingTraining = await db.write.training.findMany({
      where: { source: "ASMS" },
      select: {
        externalId: true, cwid: true, type: true, institution: true,
        specialty: true, yearFrom: true, yearTo: true, source: true,
      },
    });
    const tplan = classifyByExternalId({
      incoming: trainingInserts,
      existing: existingTraining,
      contentKey: (e) =>
        JSON.stringify([
          e.cwid, e.type, e.institution, e.specialty, e.yearFrom, e.yearTo, e.source,
        ]),
    });
    for (const batch of chunks(tplan.toCreate, INSERT_BATCH)) {
      await db.write.training.createMany({ data: batch });
    }
    for (const e of tplan.toUpdate) {
      await db.write.training.update({
        where: { externalId: e.externalId },
        data: { ...e, lastRefreshedAt: new Date() },
      });
    }
    assertPruneVolume("asms:stale-training", {
      pruning: tplan.staleExternalIds.length,
      of: existingTraining.length,
      maxPct: 10,
    });
    let trainingTombstoned = 0;
    if (tplan.staleExternalIds.length > 0) {
      trainingTombstoned = (
        await db.write.training.deleteMany({
          where: { source: "ASMS", externalId: { in: tplan.staleExternalIds } },
        })
      ).count;
    }
    console.log(
      `Training reconcile complete: +${tplan.toCreate.length} ~${tplan.toUpdate.length} -${trainingTombstoned}`,
    );

    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        completedAt: new Date(),
        rowsProcessed: inserts.length + trainingInserts.length,
      },
    });

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `ASMS ETL complete in ${elapsed}s: education rows=${inserts.length} training rows=${trainingInserts.length}`,
    );
  } catch (err) {
    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
    await closeAsmsPool();
  });
