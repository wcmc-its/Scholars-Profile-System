/**
 * Method-Family surfacing pass — comms-steward deliverable
 * (`docs/comms-steward-methods-visibility-spec.md` §6 / §10 step 4).
 * Run via `npm run etl:family-review` (also callable at the tail of `etl:tools`).
 *
 * Deterministic, idempotent, allow-by-default. For every distinct
 * `(supercategory, family_label)` in `scholar_family`, decide whether it carries
 * an animal-model signal (structural `animal_cell_models`, or a lexical term from
 * `etl/family-review/animal-model-terms.txt`) and decorate `family_review_flag`:
 *
 *   - matched, no existing row  → insert; firstSeenAt = lastSeenAt = run start.
 *   - matched, existing row     → update reason + bump lastSeenAt; keep firstSeenAt.
 *   - NOT matched, existing row → delete the flag row (the nag is gone).
 *   - NOT matched, no row        → nothing.
 *
 * NEVER changes a tier, NEVER touches either overlay, NEVER hides anything — it
 * only records the signal so a human can review it. An A2 relabel mints a new
 * `(supercategory, family_label)` key, so a renamed family re-enters as new and
 * unreviewed (firstSeenAt = this run; reviewedAt = null) — the safe direction.
 *
 * "New" = `firstSeenAt >= <this run's start>` (read by the roster query, §7).
 *
 * Env: FAMILY_REVIEW_TERMS_PATH (default etl/family-review/animal-model-terms.txt)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";
import { classifyFamily, parseTerms } from "./classify";

const SOURCE = "FamilyReview"; // etl_run.source
const TERMS_PATH =
  process.env.FAMILY_REVIEW_TERMS_PATH ?? "etl/family-review/animal-model-terms.txt";

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(`[FamilyReview] ${JSON.stringify({ event, ts: Date.now(), ...fields })}`);
}

function readTerms(): string[] {
  const abs = resolve(process.cwd(), TERMS_PATH);
  try {
    return parseTerms(readFileSync(abs, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // animal-model-terms.txt is checked into the repo — absence is a
      // packaging bug. Returning [] used to delete every lexical flag row and
      // later re-create them with reset firstSeenAt/reviewedAt, losing steward
      // review state (audit PR-3).
      throw new Error(`[FamilyReview] terms file missing at ${abs} — refusing to treat as empty`);
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
      source: SOURCE,
      status: args.status,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
    },
  });
}

interface FamilyKey {
  supercategory: string;
  familyLabel: string;
}

/** The distinct stable family identities currently present in scholar_family. */
async function loadDistinctFamilies(): Promise<FamilyKey[]> {
  const rows = await db.read.scholarFamily.findMany({
    distinct: ["supercategory", "familyLabel"],
    select: { supercategory: true, familyLabel: true },
    orderBy: [{ supercategory: "asc" }, { familyLabel: "asc" }],
  });
  return rows.map((r) => ({ supercategory: r.supercategory, familyLabel: r.familyLabel }));
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const terms = readTerms();
  log("terms_loaded", { count: terms.length, path: TERMS_PATH });

  const families = await loadDistinctFamilies();
  log("families_scanned", { distinct: families.length });

  let inserted = 0;
  let updated = 0;
  let cleared = 0;

  for (const fam of families) {
    const { reason } = classifyFamily(fam.supercategory, fam.familyLabel, terms);
    const whereUnique = {
      supercategory_familyLabel: {
        supercategory: fam.supercategory,
        familyLabel: fam.familyLabel,
      },
    };

    if (reason === null) {
      // No longer matched — drop any existing flag row (idempotent: delete-if-exists).
      const existing = await db.write.familyReviewFlag.findUnique({ where: whereUnique });
      if (existing) {
        await db.write.familyReviewFlag.delete({ where: whereUnique });
        cleared += 1;
      }
      continue;
    }

    // Matched. Insert with firstSeenAt on the first sighting; otherwise refresh
    // the reason + lastSeenAt but PRESERVE firstSeenAt (the "new" signal) and
    // PRESERVE reviewedAt/reviewedByCwid (a steward's cleared-nag is sticky).
    const existing = await db.write.familyReviewFlag.findUnique({ where: whereUnique });
    if (!existing) {
      await db.write.familyReviewFlag.create({
        data: {
          supercategory: fam.supercategory,
          familyLabel: fam.familyLabel,
          reason,
          firstSeenAt: startedAt,
          lastSeenAt: startedAt,
        },
      });
      inserted += 1;
    } else {
      await db.write.familyReviewFlag.update({
        where: whereUnique,
        data: { reason, lastSeenAt: startedAt },
      });
      updated += 1;
    }
  }

  await recordRun({ status: "success", rowsProcessed: inserted + updated });
  log("family_review_complete", {
    distinct_families: families.length,
    inserted,
    updated,
    cleared,
    durationMs: Date.now() - startedAt.getTime(),
  });
}

main()
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    log("fatal", { error: message });
    await recordRun({ status: "failed", rowsProcessed: 0, errorMessage: message }).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.write.$disconnect();
    await db.read.$disconnect();
  });
