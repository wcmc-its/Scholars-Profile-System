/**
 * Cancer Center disease-assignment ETL — persists the deterministic `assign()`
 * pipeline (`scripts/cancer-center-disease-assignments.ts`) instead of only
 * ever printing it to a CSV. Thin wrapper: all pipeline logic (MeSH rollup,
 * authorship/grant/trial scoring, confidence/focus, ranking) lives in the
 * script and is imported here unchanged via `runAssignments` — this file only
 * adds persistence, full-replacing `CancerCenterDiseaseAssignment` in a
 * transaction and recording an `EtlRun` row, same idiom as
 * `etl/cancer-taxonomy/index.ts`.
 *
 * The standalone script's CSV/CloudWatch-log workflow is unaffected — this is
 * an additional persistence path, not a replacement for it.
 *
 * Wired into the weekly state machine (`CancerCenterDiseaseAssignmentsWeekly`,
 * `cdk/lib/etl-stack.ts`) and remains runnable on-demand via this npm script --
 * the state machine step is just a scheduled invocation of the same entrypoint.
 *
 * Env:
 *   ASSIGNMENTS_AS_OF  (optional, "YYYY-MM-DD" — same knob `scripts/cancer-
 *                       center-disease-assignments.ts`'s CLI entrypoint reads)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { processStartedAt } from "@/lib/etl-run";
import { runAssignments, type Assignment } from "@/scripts/cancer-center-disease-assignments";

const ROLLUP_PATH = path.join(process.cwd(), "docs/cancer-center-person-rollup.csv");
const SPECIALTY_PATH = path.join(process.cwd(), "docs/cancer-center-specialty-map.csv");

async function recordRun(args: {
  id: string;
  status: "success" | "failed";
  rowsProcessed: number;
  taxonomyManifestSha256?: string;
  taxonomyManifestVersion?: string;
  errorMessage?: string;
}): Promise<void> {
  await db.write.etlRun.create({
    data: {
      id: args.id,
      source: "CancerCenterDiseaseAssignment",
      status: args.status,
      startedAt: processStartedAt,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
      // Same fields CancerTaxonomy's own EtlRun row uses for its own
      // provenance pair -- here they instead record WHICH CancerTaxonomy
      // generation this run's disease codes were resolved against.
      manifestSha256: args.taxonomyManifestSha256 ?? null,
      manifestTaxonomyVersion: args.taxonomyManifestVersion ?? null,
    },
  });
}

async function replaceTable(runId: string, rows: Assignment[]): Promise<number> {
  const CHUNK = 500;
  const chunks: Assignment[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));

  await db.write.$transaction(
    async (tx) => {
      await tx.cancerCenterDiseaseAssignment.deleteMany({});
      for (const batch of chunks) {
        await tx.cancerCenterDiseaseAssignment.createMany({
          data: batch.map((r) => ({
            cwid: r.cwid,
            diseaseCode: r.code,
            rank: r.rank,
            focus: r.focus,
            confidence: r.confidence,
            leadPubs: r.lead,
            secondPubs: r.second,
            middlePubs: r.middle,
            grantsLed: r.grantsLed,
            grantsSupport: r.grantsSupport,
            trialsLed: r.trialsLed,
            trialsSupport: r.trialsSupport,
            pubScore: r.pubScore,
            score: r.score,
            // 0 means "no dated publication" (see Assignment's doc comment) --
            // stored as NULL, matching the nullable column and the CSV's own
            // `r.firstYear || ""` convention.
            firstYear: r.firstYear || null,
            lastYear: r.lastYear || null,
            recentPubs: r.recentPubs,
            specialtyStatus: r.specialtyStatus,
            runId,
          })),
        });
      }
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 },
  );

  return rows.length;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const runId = randomUUID();

  const rollupCsv = readFileSync(ROLLUP_PATH, "utf8");
  const specialtyCsv = readFileSync(SPECIALTY_PATH, "utf8");

  const { rows, taxonomyManifestSha256, taxonomyManifestVersion } = await runAssignments(
    rollupCsv, specialtyCsv, process.env.ASSIGNMENTS_AS_OF,
  );
  console.log(
    `[CancerCenterDiseaseAssignment] ${JSON.stringify({
      event: "computed", ts: Date.now(), rows: rows.length,
    })}`,
  );

  const written = await replaceTable(runId, rows);
  console.log(
    `[CancerCenterDiseaseAssignment] ${JSON.stringify({ event: "table_replaced", ts: Date.now(), rows: written })}`,
  );

  await recordRun({
    id: runId, status: "success", rowsProcessed: written,
    taxonomyManifestSha256, taxonomyManifestVersion,
  });
  console.log(
    `[CancerCenterDiseaseAssignment] ${JSON.stringify({ event: "done", ts: Date.now(), duration_ms: Date.now() - startedAt })}`,
  );
}

main()
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[CancerCenterDiseaseAssignment] ${JSON.stringify({ event: "fatal", ts: Date.now(), error: message })}`);
    await recordRun({ id: randomUUID(), status: "failed", rowsProcessed: 0, errorMessage: message }).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
