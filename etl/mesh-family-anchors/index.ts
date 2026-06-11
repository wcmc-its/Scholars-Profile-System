/**
 * MeSH curated-family-anchor ETL — issue #879.
 *
 * Run via `npm run etl:mesh-family-anchors`. One run does:
 *
 *   1. Read the curated CSV at etl/mesh-family-anchors/curated.csv.
 *   2. Validate each descriptor_ui's shape and each confidence value (existence
 *      of the descriptor is validated lazily by the read path — a stale UI goes
 *      inert: getFamilyMeshDefinition finds no descriptor and returns null).
 *   3. Truncate `mesh_curated_family_anchor` and insert the curated rows, inside
 *      one $transaction so an insert failure rolls back the truncate.
 *   4. Record the run in `etl_run` under source="MeshFamilyAnchor".
 *
 * Cadence: on demand. Not wired into etl/orchestrate.ts — the seed changes only
 * when the curated CSV does (mirrors etl/mesh-aliases and etl/mesh-anchors).
 *
 * Curation flow: `npm run etl:mesh-family-anchors:seed` (seed-generate.ts)
 * PROPOSES candidate rows (confidence=derived) by co-occurrence + name-match for
 * a human to review and promote into curated.csv as confidence=curated. The
 * read path surfaces ONLY confidence=curated rows, so a derived seed never
 * reaches a page until a human verifies it.
 *
 * Env:
 *   MESH_FAMILY_ANCHOR_CURATED_PATH  (default etl/mesh-family-anchors/curated.csv)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";
import { parseFamilyAnchorCsv } from "./csv";
import type { FamilyAnchorRow } from "./types";

const CURATED_PATH =
  process.env.MESH_FAMILY_ANCHOR_CURATED_PATH ?? "etl/mesh-family-anchors/curated.csv";
const DESCRIPTOR_UI_RE = /^D\d{6,}$/;

async function recordRun(args: {
  status: "success" | "failed";
  rowsProcessed: number;
  errorMessage?: string;
}): Promise<void> {
  await db.write.etlRun.create({
    data: {
      source: "MeshFamilyAnchor",
      status: args.status,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
    },
  });
}

function readCurated(): FamilyAnchorRow[] {
  const abs = resolve(process.cwd(), CURATED_PATH);
  let text: string;
  try {
    text = readFileSync(abs, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(
        `[MeshFamilyAnchor] ${JSON.stringify({ event: "curated_csv_missing", path: abs })}`,
      );
      return [];
    }
    throw err;
  }
  return parseFamilyAnchorCsv(text);
}

async function replaceAnchors(rows: FamilyAnchorRow[]): Promise<void> {
  const CHUNK = 500;
  await db.write.$transaction(
    async (tx) => {
      await tx.meshCuratedFamilyAnchor.deleteMany({});
      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK);
        await tx.meshCuratedFamilyAnchor.createMany({
          data: batch.map((a) => ({
            supercategory: a.supercategory,
            familyLabel: a.familyLabel,
            descriptorUi: a.descriptorUi,
            confidence: a.confidence,
            sourceNote: a.sourceNote,
            refreshedAt: new Date(),
          })),
          skipDuplicates: true,
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
        `[MeshFamilyAnchor] invalid descriptor_ui "${r.descriptorUi}" for (${r.supercategory}, ${r.familyLabel}) (expected /^D\\d{6,}$/)`,
      );
    }
  }

  await replaceAnchors(rows);
  await recordRun({ status: "success", rowsProcessed: rows.length });

  const curated = rows.filter((r) => r.confidence === "curated").length;
  console.log(
    `[MeshFamilyAnchor] ${JSON.stringify({
      event: "mesh_family_anchor_etl_complete",
      rows: rows.length,
      curated,
      derived: rows.length - curated,
      durationMs: Date.now() - startedAt,
    })}`,
  );
}

main()
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[MeshFamilyAnchor] ${JSON.stringify({ event: "fatal", error: message })}`);
    await recordRun({ status: "failed", rowsProcessed: 0, errorMessage: message }).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
