/**
 * Family sensitivity-overlay ETL — #801. Run via `npm run etl:family-sensitivity`.
 *
 * Seeds `family_sensitivity_overlay` (the #801 audience-gating overlay) from the
 * curated CSV at etl/family-sensitivity/curated.csv — the External-Affairs-approved
 * live-animal-model family subset. One run:
 *   1. Read + validate the curated CSV (supercategory, family_label, source_note).
 *   2. SEED-SAFE reseed (DB-as-source-of-truth, spec §5/§10.3): only insert/replace
 *      rows whose `source='seed'`; NEVER delete or overwrite a `source='steward'`
 *      row (a tier set from the /edit/methods surface), NOR resurrect a family
 *      that has ANY row in `family_tier_decision` (#1993 — this is what makes a
 *      steward's Public decision, which leaves no overlay row at all, survive a
 *      reseed). Steward-owned and decision-owned keys are skipped entirely,
 *      stale seed rows that left the CSV are dropped, all inside one
 *      $transaction so a failure rolls the whole reseed back. The curated CSV
 *      is a one-time bootstrap, not a recurring truncate.
 *   3. Record the run in `etl_run` under source="FamilySensitivity".
 *
 * Editorial / Compliance-owned, on demand (not in etl/orchestrate.ts — the seed
 * changes only when the curated CSV does). Keyed on the stable
 * (supercategory, family_label) pair; A2 re-mints family_id every rebuild.
 *
 * INERT until `METHODS_LENS_SENSITIVE_GATE=on` AND `METHODS_LENS_ENABLED=on` for
 * the env — partitionScholarFamilies only consults this overlay when both gates
 * are on (lib/api/profile.ts).
 *
 * An EMPTY curated CSV is refused, not honoured. A zero-row parse would delete
 * every `source='seed'` row and record status='success' — the un-gating would
 * be invisible to the freshness monitor, which grades on the recency of the
 * last SUCCESS and never reads rowsProcessed. Throwing converts that into a
 * FAILED run, which is a signal something watches. To retire the seed layer
 * deliberately, remove the step or clear the table explicitly — not by
 * truncating the CSV.
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

/**
 * Read + parse the curated CSV, refusing both ways it can yield zero rows.
 *
 * Exported for unit test. The two guards close the SAME hole from opposite
 * ends: `replaceRows([])` keeps no seed key, so every `source='seed'` row is
 * pruned as stale inside the transaction and `main()` still records
 * status='success' with rowsProcessed=0. Freshness cannot see that — it grades
 * a source on the recency of its last SUCCESS row and never reads
 * rowsProcessed — so a wipe-to-empty would look perfectly healthy. Throwing
 * here leaves the overlay untouched (replaceRows has not run) and records
 * status='failed', which the freshness entry for FamilySensitivity does catch.
 *
 * With METHODS_LENS_SENSITIVE_GATE on, the wipe direction is the unsafe one:
 * an emptied overlay renders every previously-gated family PUBLICLY.
 */
export function readCurated(): SensitiveRow[] {
  const abs = resolve(process.cwd(), CURATED_PATH);
  let rows: SensitiveRow[];
  try {
    rows = parseCsv(readFileSync(abs, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // The curated CSV is checked into the repo — its absence is a packaging
      // bug, not "zero rows". Returning [] here used to silently delete the
      // curated seed sensitivity overlay and record SUCCESS (audit PR-3).
      throw new Error(
        `[FamilySensitivity] curated CSV missing at ${abs} — refusing to treat as empty`,
      );
    }
    throw err;
  }
  // Present but empty (header-only, truncated, or a bad checkout) — same
  // destructive outcome as ENOENT, so it gets the same answer.
  if (rows.length === 0) {
    throw new Error(
      `[FamilySensitivity] curated CSV parsed to 0 rows at ${abs} — refusing to wipe the overlay`,
    );
  }
  return rows;
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

/** Stable identity key for an overlay row — the (supercategory, family_label) pair. */
function rowKey(supercategory: string, familyLabel: string): string {
  return `${supercategory}\u0000${familyLabel}`;
}

/**
 * Curated rows whose (supercategory, family_label) names no real family. The overlay is
 * exact-string-joined against `scholar_family` at read time, so an unmatched label seeds a
 * row that gates nothing — a typo, or a label an A2 rebuild renamed out from under the CSV.
 * Exported for unit test. Ported from etl/family-suppression, which has had this guard.
 */
export function findUnknownFamilies(
  rows: SensitiveRow[],
  knownKeys: Set<string>,
): SensitiveRow[] {
  return rows.filter((r) => !knownKeys.has(rowKey(r.supercategory, r.familyLabel)));
}

/**
 * The full reseed skip-set (#1993): every (supercategory, family_label) key that
 * this loader must never insert, update, or delete. Union of two independent
 * sources —
 *
 *   - `source='steward'` rows in THIS loader's own overlay table (the original
 *     #2053 guard; catches Sensitive today).
 *   - EVERY key in `family_tier_decision`, regardless of its recorded tier. This
 *     is the part that closes #1993: a family a steward set to Public has NO row
 *     in `family_sensitivity_overlay` at all, so the steward-rows check above
 *     never sees it — only the decision table does.
 *
 * Exported for unit test; the surrounding DB queries are trivial.
 */
export function computeSkipKeys(
  stewardRows: { supercategory: string; familyLabel: string }[],
  decisionRows: { supercategory: string; familyLabel: string }[],
): Set<string> {
  const keys = new Set<string>();
  for (const r of stewardRows) keys.add(rowKey(r.supercategory, r.familyLabel));
  for (const r of decisionRows) keys.add(rowKey(r.supercategory, r.familyLabel));
  return keys;
}

/**
 * Fail closed when a curated label matches no family. Throwing here leaves the overlay
 * exactly as it was — `replaceRows` has not run — so a bad CSV never strips existing
 * gating; it just refuses to apply. That is the safe direction: with
 * METHODS_LENS_SENSITIVE_GATE on, an inert row means the family renders PUBLICLY while the
 * curated list still reads as complete. Five rows drifted that way before this guard.
 *
 * Queries via `db.write` so the single `db.write.$disconnect()` in the finally block covers
 * it — a `db.read` query under a set DATABASE_URL_RO opens a second pool nothing closes.
 */
async function assertLabelsMatchFamilies(rows: SensitiveRow[]): Promise<void> {
  const families = await db.write.scholarFamily.findMany({
    select: { supercategory: true, familyLabel: true },
    distinct: ["supercategory", "familyLabel"],
  });
  if (families.length === 0) {
    // Nothing to validate against: scholar_family is dormant until the A2 load runs. Every
    // overlay row is inert in that state anyway, so seeding is harmless — but say so loudly.
    console.warn(
      `[FamilySensitivity] ${JSON.stringify({
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
      `[FamilySensitivity] ${unknown.length} curated label(s) match no family in scholar_family — ` +
        `refusing to seed inert rows: ${offenders}`,
    );
  }
}

/** What the reseed actually changed. A CSV row count cannot tell a no-op from a mass rewrite. */
type ReseedCounts = { inserted: number; updated: number; deleted: number };

/**
 * Seed-safe reseed (spec §5/§10.3). The DB is the source of truth: a comms-steward
 * tier set writes `source='steward'` rows that this seed ETL must never clobber.
 *
 *   - Load every existing steward-owned key; skip those keys entirely (the CSV must
 *     not resurrect a row the steward deliberately set/removed).
 *   - Upsert each non-steward CSV key as `source='seed'` (insert or refresh).
 *   - Delete only `source='seed'` rows whose key left the CSV (stale-seed cleanup);
 *     steward rows are never deleted.
 *
 * All inside one $transaction so a partial failure rolls back the whole reseed.
 */
export async function replaceRows(rows: SensitiveRow[]): Promise<ReseedCounts> {
  return db.write.$transaction(
    async (tx) => {
      // Steward-owned keys (this overlay's own `source='steward'` rows) plus every
      // key with an explicit FamilyTierDecision (#1993 — catches Public, which has
      // no overlay row in either table) are off-limits: never insert, overwrite, or
      // delete them.
      const [stewardRows, decisionRows] = await Promise.all([
        tx.familySensitivityOverlay.findMany({
          where: { source: "steward" },
          select: { supercategory: true, familyLabel: true },
        }),
        tx.familyTierDecision.findMany({
          select: { supercategory: true, familyLabel: true },
        }),
      ]);
      const stewardKeys = computeSkipKeys(stewardRows, decisionRows);

      // Snapshot the seed rows BEFORE the upsert loop so the run can report what actually
      // changed. `rowsProcessed` on its own is the CSV length, which cannot distinguish a
      // no-op from a mass resurrection — the ambiguity that hid 22 rows returning in prod.
      const existingSeed = await tx.familySensitivityOverlay.findMany({
        where: { source: "seed" },
        select: { supercategory: true, familyLabel: true },
      });
      const existingSeedKeys = new Set(
        existingSeed.map((r) => rowKey(r.supercategory, r.familyLabel)),
      );

      // Seed rows we intend to keep — used to prune stale seed rows that left the CSV.
      const seedKeysToKeep = new Set<string>();
      let inserted = 0;
      let updated = 0;

      for (const r of rows) {
        const key = rowKey(r.supercategory, r.familyLabel);
        if (stewardKeys.has(key)) continue; // steward owns this family; leave it alone
        seedKeysToKeep.add(key);
        if (existingSeedKeys.has(key)) updated += 1;
        else inserted += 1;
        await tx.familySensitivityOverlay.upsert({
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
      const staleSeed = existingSeed.filter(
        (r) => !seedKeysToKeep.has(rowKey(r.supercategory, r.familyLabel)),
      );
      for (const r of staleSeed) {
        await tx.familySensitivityOverlay.delete({
          where: {
            supercategory_familyLabel: {
              supercategory: r.supercategory,
              familyLabel: r.familyLabel,
            },
          },
        });
      }

      return { inserted, updated, deleted: staleSeed.length };
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 },
  );
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const rows = readCurated();
  await assertLabelsMatchFamilies(rows);
  const counts = await replaceRows(rows);
  await recordRun({ status: "success", rowsProcessed: rows.length });
  console.log(
    `[FamilySensitivity] ${JSON.stringify({
      event: "family_sensitivity_etl_complete",
      rows: rows.length,
      ...counts,
      durationMs: Date.now() - startedAt,
    })}`,
  );
}

// Guarded so the module can be imported by a unit test without running the ETL
// (mirrors etl/family-suppression).
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main()
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[FamilySensitivity] ${JSON.stringify({ event: "fatal", error: message })}`);
      await recordRun({ status: "failed", rowsProcessed: 0, errorMessage: message }).catch(
        () => {},
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.write.$disconnect();
    });
}
