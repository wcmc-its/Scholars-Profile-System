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
 * Env:
 *   MESH_ALIAS_CURATED_PATH  (default etl/mesh-aliases/curated.csv)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";
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
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
    },
  });
}

function readCurated(): AliasRow[] {
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
  return parseAliasCsv(text);
}

async function replaceAliases(rows: AliasRow[]): Promise<void> {
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
