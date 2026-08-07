/**
 * MeSH curated-alias ETL — issue #642.
 *
 * Run via `npm run etl:mesh-aliases`. One run does:
 *
 *   1. Read curated CSV at etl/mesh-aliases/curated.csv.
 *   2. Validate each descriptor_ui's shape (existence is validated lazily by
 *      the resolver — a stale UI goes inert).
 *   3. Truncate `mesh_curated_alias` and insert the curated rows, inside one
 *      $transaction so an insert failure rolls back the truncate.
 *   4. Record the run in `etl_run` under source="MeshAlias".
 *
 * Cadence: on demand. Not wired into etl/orchestrate.ts — the seed changes
 * only when the curated CSV does.
 *
 * The resolver's in-memory MeSH map (§1.5) keeps serving its previous load
 * until the next ≤1h refresh tick, so an aborted run causes no visible
 * breakage and a successful run is picked up within the hour (or on restart).
 *
 * An EMPTY curated CSV is refused, not honoured. Step 3 is an unconditional
 * `deleteMany({})`, so a zero-row parse truncates `mesh_curated_alias` and
 * still records status='success' — invisible to the freshness monitor, which
 * grades on the recency of the last SUCCESS and never reads rowsProcessed.
 * Throwing converts that into a FAILED run, which is a signal something
 * watches. To retire the alias layer deliberately, remove the step or clear
 * the table explicitly — not by truncating the CSV.
 *
 * Env:
 *   MESH_ALIAS_CURATED_PATH  (default etl/mesh-aliases/curated.csv)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";
import { processStartedAt } from "@/lib/etl-run";
import { parseAliasCsv } from "./csv";
import type { AliasRow } from "./types";

const CURATED_PATH = process.env.MESH_ALIAS_CURATED_PATH ?? "etl/mesh-aliases/curated.csv";
const DESCRIPTOR_UI_RE = /^D\d{6,}$/;

async function recordRun(args: {
  status: "success" | "failed";
  rowsProcessed: number;
  errorMessage?: string;
}): Promise<void> {
  await db.write.etlRun.create({
    data: {
      source: "MeshAlias",
      status: args.status,
      startedAt: processStartedAt,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
    },
  });
}

/**
 * Read + parse the curated CSV, refusing both ways it can yield zero rows.
 *
 * Exported for unit test. The two guards close the SAME hole from opposite
 * ends: `replaceAliases([])` runs the unconditional `deleteMany({})` and then
 * inserts nothing, and `main()` still records status='success' with
 * rowsProcessed=0. Freshness cannot see that — it grades a source on the
 * recency of its last SUCCESS row and never reads rowsProcessed — so a
 * truncate-to-empty would look perfectly healthy. Throwing here leaves the
 * table untouched (replaceAliases has not run) and records status='failed',
 * which the freshness entry for MeshAlias does catch.
 *
 * A header-only file is the realistic shape: `parseAliasCsv` accepts it and
 * returns [], which is why the ENOENT guard alone was not enough.
 */
export function readCurated(): AliasRow[] {
  const abs = resolve(process.cwd(), CURATED_PATH);
  let text: string;
  try {
    text = readFileSync(abs, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // curated.csv is checked into the repo — absence is a packaging bug.
      // Returning [] used to wipe mesh_curated_alias to empty under a SUCCESS run.
      throw new Error(`[MeshAlias] curated CSV missing at ${abs} — refusing to treat as empty`);
    }
    throw err;
  }
  const rows = parseAliasCsv(text);
  if (rows.length === 0) {
    throw new Error(
      `[MeshAlias] curated CSV parsed to 0 rows at ${abs} — refusing to wipe the alias table`,
    );
  }
  return rows;
}

/** Truncate + re-insert, in one transaction. Exported for unit test. */
export async function replaceAliases(rows: AliasRow[]): Promise<void> {
  const CHUNK = 500;
  await db.write.$transaction(
    async (tx) => {
      await tx.meshCuratedAlias.deleteMany({});
      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK);
        await tx.meshCuratedAlias.createMany({
          data: batch.map((a) => ({
            alias: a.alias,
            descriptorUi: a.descriptorUi,
            sourceNote: a.sourceNote,
            refreshedAt: new Date(),
          })),
        });
      }
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 },
  );
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const rows = readCurated();

  for (const r of rows) {
    if (!DESCRIPTOR_UI_RE.test(r.descriptorUi)) {
      throw new Error(
        `[MeshAlias] invalid descriptor_ui "${r.descriptorUi}" for alias "${r.alias}" (expected /^D\\d{6,}$/)`,
      );
    }
  }

  await replaceAliases(rows);
  await recordRun({ status: "success", rowsProcessed: rows.length });

  console.log(
    `[MeshAlias] ${JSON.stringify({
      event: "mesh_alias_etl_complete",
      rows: rows.length,
      durationMs: Date.now() - startedAt,
    })}`,
  );
}

// Guarded so the module can be imported by a unit test without running the ETL
// (mirrors etl/family-suppression and etl/family-sensitivity). Verified true
// under the `tsx etl/mesh-aliases/index.ts` invocation this ships as.
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main()
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[MeshAlias] ${JSON.stringify({ event: "fatal", error: message })}`);
      await recordRun({ status: "failed", rowsProcessed: 0, errorMessage: message }).catch(() => {});
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.write.$disconnect();
    });
}
