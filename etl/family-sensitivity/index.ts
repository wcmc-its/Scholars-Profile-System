/**
 * Family sensitivity-overlay ETL — #801. Run via `npm run etl:family-sensitivity`.
 *
 * Seeds `family_sensitivity_overlay` (the #801 audience-gating overlay) from the
 * curated CSV at etl/family-sensitivity/curated.csv — the External-Affairs-approved
 * live-animal-model family subset. One run:
 *   1. Read + validate the curated CSV (supercategory, family_label, source_note).
 *   2. Truncate `family_sensitivity_overlay` and insert the curated rows, inside
 *      one $transaction so an insert failure rolls back the truncate.
 *   3. Record the run in `etl_run` under source="FamilySensitivity".
 *
 * Editorial / Compliance-owned, on demand (not in etl/orchestrate.ts — the seed
 * changes only when the curated CSV does). Keyed on the stable
 * (supercategory, family_label) pair; A2 re-mints family_id every rebuild.
 *
 * INERT until `METHODS_LENS_SENSITIVE_GATE=on` AND `METHODS_LENS_ENABLED=on` for
 * the env — partitionScholarFamilies only consults this overlay when both gates
 * are on (lib/api/profile.ts). Truncating it (empty CSV) cleanly un-gates.
 *
 * Env: FAMILY_SENSITIVITY_CURATED_PATH (default etl/family-sensitivity/curated.csv)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";

const CURATED_PATH =
  process.env.FAMILY_SENSITIVITY_CURATED_PATH ?? "etl/family-sensitivity/curated.csv";

type SensitiveRow = { supercategory: string; familyLabel: string; sourceNote: string | null };

function parseCsv(text: string): SensitiveRow[] {
  const out: SensitiveRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (i === 0 && /^supercategory\s*,/i.test(line)) continue; // header
    // supercategory + family_label never contain commas (snake_case ids /
    // taxonomy labels); only source_note might, so it absorbs the remainder.
    const parts = line.split(",");
    const supercategory = (parts[0] ?? "").trim();
    const familyLabel = (parts[1] ?? "").trim();
    const sourceNote = parts.slice(2).join(",").trim() || null;
    if (!supercategory || !familyLabel) {
      throw new Error(`[FamilySensitivity] malformed CSV row ${i + 1}: "${line}"`);
    }
    out.push({ supercategory, familyLabel, sourceNote });
  }
  return out;
}

function readCurated(): SensitiveRow[] {
  const abs = resolve(process.cwd(), CURATED_PATH);
  try {
    return parseCsv(readFileSync(abs, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(
        `[FamilySensitivity] ${JSON.stringify({ event: "curated_csv_missing", path: abs })}`,
      );
      return [];
    }
    throw err;
  }
}

async function recordRun(args: {
  status: "success" | "failed";
  rowsProcessed: number;
  errorMessage?: string;
}): Promise<void> {
  await db.write.etlRun.create({
    data: {
      source: "FamilySensitivity",
      status: args.status,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
    },
  });
}

async function replaceRows(rows: SensitiveRow[]): Promise<void> {
  const CHUNK = 500;
  await db.write.$transaction(
    async (tx) => {
      await tx.familySensitivityOverlay.deleteMany({});
      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK);
        await tx.familySensitivityOverlay.createMany({
          data: batch.map((r) => ({
            supercategory: r.supercategory,
            familyLabel: r.familyLabel,
            sourceNote: r.sourceNote,
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
  await replaceRows(rows);
  await recordRun({ status: "success", rowsProcessed: rows.length });
  console.log(
    `[FamilySensitivity] ${JSON.stringify({
      event: "family_sensitivity_etl_complete",
      rows: rows.length,
      durationMs: Date.now() - startedAt,
    })}`,
  );
}

main()
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[FamilySensitivity] ${JSON.stringify({ event: "fatal", error: message })}`);
    await recordRun({ status: "failed", rowsProcessed: 0, errorMessage: message }).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
