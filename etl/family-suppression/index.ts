/**
 * Family suppression-overlay ETL — #800. Run via `npm run etl:family-suppression`.
 *
 * Seeds `family_suppression_overlay` (the #800 hard-hide overlay) from the curated
 * CSV at etl/family-suppression/curated.csv — the data-steward-owned list of
 * non-distinctive method families (e.g. generic statistical tests, generic study
 * designs) that should never surface in the methods lens. One run:
 *   1. Read + validate the curated CSV (supercategory, family_label, source_note),
 *      then check every label against `scholar_family` — the overlay joins on the
 *      exact string, so an unmatched label would seed a row that hides nothing.
 *   2. SEED-SAFE reseed (DB-as-source-of-truth): only insert/replace rows whose
 *      `source='seed'`; NEVER delete or overwrite a `source='steward'` row (a tier
 *      set from the /edit/methods surface). Steward-owned keys are skipped entirely,
 *      stale seed rows that left the CSV are dropped, all inside one $transaction so
 *      a failure rolls the whole reseed back. The curated CSV is a one-time
 *      bootstrap, not a recurring truncate.
 *   3. Record the run in `etl_run` under source="FamilySuppression".
 *
 * Editorial / data-steward-owned, on demand (NOT in etl/orchestrate.ts — the seed
 * changes only when the curated CSV does). Keyed on the stable
 * (supercategory, family_label) pair; A2 re-mints family_id every rebuild.
 *
 * Effect is UNCONDITIONAL — unlike #801 sensitivity (which needs
 * METHODS_LENS_SENSITIVE_GATE), `loadFamilyOverlayGate` reads the suppression
 * overlay on every request. It is only CONSULTED where the methods lens renders
 * families (`partitionScholarFamilies`), so a populated CSV takes effect wherever
 * `METHODS_LENS_ENABLED=on` (staging today; prod at the lens go-live). An empty
 * CSV is a clean no-op; truncating it (empty CSV) cleanly un-hides every seed row.
 *
 * Env: FAMILY_SUPPRESSION_CURATED_PATH (default etl/family-suppression/curated.csv)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";

const CURATED_PATH =
  process.env.FAMILY_SUPPRESSION_CURATED_PATH ?? "etl/family-suppression/curated.csv";

type SuppressedRow = { supercategory: string; familyLabel: string; sourceNote: string | null };

function parseCsv(text: string): SuppressedRow[] {
  const out: SuppressedRow[] = [];
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
      throw new Error(`[FamilySuppression] malformed CSV row ${i + 1}: "${line}"`);
    }
    out.push({ supercategory, familyLabel, sourceNote });
  }
  return out;
}

function readCurated(): SuppressedRow[] {
  const abs = resolve(process.cwd(), CURATED_PATH);
  try {
    return parseCsv(readFileSync(abs, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // The curated CSV is checked into the repo — its absence is a packaging
      // bug, not "zero rows". Returning [] here used to silently delete the
      // curated seed suppression rows and record SUCCESS (audit PR-3).
      throw new Error(
        `[FamilySuppression] curated CSV missing at ${abs} — refusing to treat as empty`,
      );
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
      source: "FamilySuppression",
      status: args.status,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
    },
  });
}

/** Stable identity key for an overlay row — the (supercategory, family_label) pair. */
function rowKey(supercategory: string, familyLabel: string): string {
  return `${supercategory} ${familyLabel}`;
}

/**
 * Curated rows whose (supercategory, family_label) names no real family. The overlay is
 * exact-string-joined against `scholar_family` at read time, so an unmatched label inserts
 * a row that hides nothing — a silent typo. Exported for unit test.
 */
export function findUnknownFamilies(
  rows: SuppressedRow[],
  knownKeys: Set<string>,
): SuppressedRow[] {
  return rows.filter((r) => !knownKeys.has(rowKey(r.supercategory, r.familyLabel)));
}

/**
 * Fail closed when a curated label matches no family. Queries via `db.write` so the single
 * `db.write.$disconnect()` in the finally block covers it — a `db.read` query under a set
 * DATABASE_URL_RO opens a second pool nothing ever closes, which hangs the run.
 */
async function assertLabelsMatchFamilies(rows: SuppressedRow[]): Promise<void> {
  const families = await db.write.scholarFamily.findMany({
    select: { supercategory: true, familyLabel: true },
    distinct: ["supercategory", "familyLabel"],
  });
  if (families.length === 0) {
    // Nothing to validate against: scholar_family is dormant until the A2 load runs. Every
    // overlay row is inert in that state anyway, so seeding is harmless — but say so loudly.
    console.warn(
      `[FamilySuppression] ${JSON.stringify({
        event: "family_table_empty_validation_skipped",
        rows: rows.length,
      })}`,
    );
    return;
  }
  const known = new Set(families.map((f) => rowKey(f.supercategory, f.familyLabel)));
  const unknown = findUnknownFamilies(rows, known);
  if (unknown.length > 0) {
    const offenders = unknown.map((r) => `(${r.supercategory}, "${r.familyLabel}")`).join("; ");
    throw new Error(
      `[FamilySuppression] ${unknown.length} curated label(s) match no family in scholar_family — ` +
        `refusing to seed inert rows: ${offenders}`,
    );
  }
}

/**
 * Seed-safe reseed. The DB is the source of truth: a comms-steward tier set writes
 * `source='steward'` rows that this seed ETL must never clobber.
 *
 *   - Load every existing steward-owned key; skip those keys entirely (the CSV must
 *     not resurrect a row the steward deliberately set/removed).
 *   - Upsert each non-steward CSV key as `source='seed'` (insert or refresh).
 *   - Delete only `source='seed'` rows whose key left the CSV (stale-seed cleanup);
 *     steward rows are never deleted.
 *
 * All inside one $transaction so a partial failure rolls back the whole reseed.
 */
async function replaceRows(rows: SuppressedRow[]): Promise<void> {
  await db.write.$transaction(
    async (tx) => {
      // Steward-owned keys are off-limits — never insert, overwrite, or delete them.
      const stewardRows = await tx.familySuppressionOverlay.findMany({
        where: { source: "steward" },
        select: { supercategory: true, familyLabel: true },
      });
      const stewardKeys = new Set(
        stewardRows.map((r) => rowKey(r.supercategory, r.familyLabel)),
      );

      // Seed rows we intend to keep — used to prune stale seed rows that left the CSV.
      const seedKeysToKeep = new Set<string>();

      for (const r of rows) {
        const key = rowKey(r.supercategory, r.familyLabel);
        if (stewardKeys.has(key)) continue; // steward owns this family; leave it alone
        seedKeysToKeep.add(key);
        await tx.familySuppressionOverlay.upsert({
          where: {
            supercategory_familyLabel: {
              supercategory: r.supercategory,
              familyLabel: r.familyLabel,
            },
          },
          create: {
            supercategory: r.supercategory,
            familyLabel: r.familyLabel,
            sourceNote: r.sourceNote,
            source: "seed",
            refreshedAt: new Date(),
          },
          update: {
            sourceNote: r.sourceNote,
            source: "seed",
            refreshedAt: new Date(),
          },
        });
      }

      // Stale-seed cleanup: drop seed rows whose key is no longer in the CSV. The
      // `source='seed'` filter guarantees steward rows are never touched.
      const existingSeed = await tx.familySuppressionOverlay.findMany({
        where: { source: "seed" },
        select: { supercategory: true, familyLabel: true },
      });
      const staleSeed = existingSeed.filter(
        (r) => !seedKeysToKeep.has(rowKey(r.supercategory, r.familyLabel)),
      );
      for (const r of staleSeed) {
        await tx.familySuppressionOverlay.delete({
          where: {
            supercategory_familyLabel: {
              supercategory: r.supercategory,
              familyLabel: r.familyLabel,
            },
          },
        });
      }
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 },
  );
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const rows = readCurated();
  await assertLabelsMatchFamilies(rows);
  await replaceRows(rows);
  await recordRun({ status: "success", rowsProcessed: rows.length });
  console.log(
    `[FamilySuppression] ${JSON.stringify({
      event: "family_suppression_etl_complete",
      rows: rows.length,
      durationMs: Date.now() - startedAt,
    })}`,
  );
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main()
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[FamilySuppression] ${JSON.stringify({ event: "fatal", error: message })}`);
      await recordRun({ status: "failed", rowsProcessed: 0, errorMessage: message }).catch(() => {});
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.write.$disconnect();
    });
}
