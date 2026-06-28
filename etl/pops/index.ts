/**
 * POPS clinical enrichment ETL — spec §2 (pops-clinical-search-spec.md).
 *
 * Nightly backfill of board certifications, primary specialties, and clinical
 * expertise from the WCM physician directory (POPS) for scholars where
 * hasClinicalProfile = true. Persists the results to the four new Scholar
 * columns so the OpenSearch reindex (which runs after all source ETLs) can
 * emit clinicalSpecialties / clinicalExpertise / clinicalBoardSet on each
 * people document.
 *
 * Shape:
 *   1. Cohort — scholars where hasClinicalProfile = true, not soft-deleted.
 *   2. Per-cwid fetch via fetchPops() with ~150 ms inter-request sleep
 *      (fetchPops has no built-in throttle; this is the house pattern).
 *   3. Transform via normalizeClinical() — case-insensitive specialty dedup.
 *   4. Upsert scholar row (popsBoardCertifications / popsSpecialties /
 *      popsExpertise / popsRefreshedAt). Idempotent.
 *
 * Privacy: POPS is the PUBLIC weillcornell.org directory — no is_hidden
 * filtering and no data-owner sign-off required (spec §1).
 *
 * Usage: `npm run etl:pops`
 */
import { db } from "../../lib/db";
import { fetchPops, type PopsEnrichment } from "../../lib/edit/pops";

/** Inter-request sleep to be a good citizen toward the POPS directory.
 *  fetchPops() has no built-in throttle (it is designed for one-off CV calls). */
const POPS_SLEEP_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// normalizeClinical — EXPORTED for unit testing
// ---------------------------------------------------------------------------

export interface NormalizedClinical {
  /** Board certification objects [{board, specialty}] — specialty may be null
   *  when POPS has no mapped_specialty for the certification. */
  boardCertifications: { board: string; specialty: string | null }[];
  /** Board-cert specialties UNION primary_specialties, deduped case-insensitively.
   *  Board-cert strings win on capitalization when a case-collision occurs. */
  specialties: string[];
  /** Clinical expertise / problem_procedure strings. */
  expertise: string[];
  /** Subset of specialties that come from a board certification (for the
   *  `boardCertified` label in the search explanation). */
  boardSet: string[];
}

/**
 * Pure transform: maps a PopsEnrichment payload into the four normalized
 * fields that the ETL stores and the search-index doc layer reads.
 */
export function normalizeClinical(pops: PopsEnrichment): NormalizedClinical {
  // Board-cert specialty strings (non-null only — null means POPS has no
  // mapped specialty for that certification, so it cannot contribute to search).
  const boardSet = pops.boardCertifications
    .map((c) => c.specialty)
    .filter((s): s is string => s !== null && s.trim() !== "");

  // Case-insensitive dedup: board-cert specialties first (win on casing),
  // then primary specialties fill in any that aren't already present.
  const seen = new Map<string, string>(); // lowercase key → canonical string
  for (const s of boardSet) {
    const key = s.toLowerCase();
    if (!seen.has(key)) seen.set(key, s);
  }
  for (const s of pops.specialties) {
    if (!s) continue;
    const key = s.toLowerCase();
    if (!seen.has(key)) seen.set(key, s);
  }

  return {
    boardCertifications: pops.boardCertifications,
    specialties: Array.from(seen.values()),
    expertise: pops.expertise,
    boardSet,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const start = Date.now();
  const run = await db.write.etlRun.create({
    data: { source: "POPS", status: "running" },
  });

  try {
    // 1. Cohort: hasClinicalProfile = true, not soft-deleted.
    const scholars = await db.write.scholar.findMany({
      where: { hasClinicalProfile: true, deletedAt: null },
      select: { cwid: true },
    });
    console.log(`POPS ETL: ${scholars.length} clinical scholars in cohort.`);

    let fetched = 0;
    let persisted = 0;
    let missed = 0;

    // 2. Per-cwid fetch + upsert (sequential; fetchPops is best-effort).
    for (let i = 0; i < scholars.length; i++) {
      const { cwid } = scholars[i]!;

      let pops: PopsEnrichment | null = null;
      try {
        pops = await fetchPops(cwid);
      } catch {
        // fetchPops already swallows errors and returns null; this outer catch
        // is a belt-and-suspenders guard — never abort the loop.
        pops = null;
      }

      if (!pops) {
        missed++;
      } else {
        fetched++;
        const normalized = normalizeClinical(pops);

        // 3. Upsert: write all four POPS columns atomically.
        await db.write.scholar.update({
          where: { cwid },
          data: {
            popsBoardCertifications: normalized.boardCertifications,
            popsSpecialties: normalized.specialties,
            popsExpertise: normalized.expertise,
            popsRefreshedAt: new Date(),
          },
        });
        persisted++;
      }

      // Progress log every 100 scholars.
      if ((i + 1) % 100 === 0) {
        console.log(`  ...${i + 1}/${scholars.length} (fetched=${fetched}, missed=${missed})`);
      }

      // Inter-request throttle — skip on the last scholar to avoid unnecessary wait.
      if (i < scholars.length - 1) {
        await sleep(POPS_SLEEP_MS);
      }
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `POPS ETL complete in ${elapsed}s: cohort=${scholars.length}, ` +
        `fetched=${fetched}, persisted=${persisted}, missed=${missed}.`,
    );

    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: persisted },
    });
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

// Guard: do not run when imported by vitest — mirrors etl/reciter/index.ts.
if (!process.env.VITEST) {
  main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await db.write.$disconnect();
    });
}
