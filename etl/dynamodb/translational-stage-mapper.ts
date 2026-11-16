/**
 * Pure helper for etl/dynamodb/index.ts Block 4 (IMPACT# -> publication): the
 * translational-stage half of the IMPACT# record, split out so the row parsing
 * can be unit-tested without a DynamoDB scan or a database (same split as
 * ./publication-topic-mapper.ts).
 *
 * ReCiterAI writes `translational_stage` ("T0" | "T1" | "T2" | "T3-4" | "NA")
 * and, optionally, `translational_stage_confidence` ("high" | "medium" | "low")
 * on the IMPACT# item. Two rules the caller depends on:
 *
 *   - Independent of `impact_score`. Some IMPACT# items carry a stage and no
 *     numeric score; the impact half of Block 4 skips those, this half does not.
 *   - Write-only-when-present. An item with no valid stage yields NO write, so
 *     a degraded or partial scan can never null out a stage already stored.
 *
 * The stage and its confidence are written as a pair: a valid stage with no
 * (or an unknown) confidence stores confidence NULL, so a stale confidence
 * never outlives the stage it described.
 */
import {
  parseTranslationalStage,
  parseTranslationalStageConfidence,
  type RawTranslationalStage,
  type TranslationalStageConfidence,
} from "../../lib/translational-stage";

/** Minimal shape of an IMPACT# record this module reads. */
export type ImpactStageInput = {
  PK: string; // IMPACT#pmid_<pmid>
  pmid?: string | number;
  translational_stage?: unknown;
  translational_stage_confidence?: unknown;
};

export type TranslationalStageWrite = {
  pmid: string;
  translationalStage: RawTranslationalStage;
  translationalStageConfidence: TranslationalStageConfidence | null;
};

const IMPACT_PK_PREFIX = "IMPACT#pmid_";

/** The pmid of an IMPACT# record: the `pmid` attribute when usable, else the
 *  PK suffix. "" when neither yields one. */
export function impactRecordPmid(it: { PK: string; pmid?: string | number }): string {
  return typeof it.pmid === "number" && Number.isFinite(it.pmid)
    ? String(it.pmid)
    : typeof it.pmid === "string" && /^\d+$/.test(it.pmid.trim())
      ? it.pmid.trim()
      : it.PK.startsWith(IMPACT_PK_PREFIX)
        ? it.PK.slice(IMPACT_PK_PREFIX.length)
        : "";
}

export type TranslationalStageWritePlan = {
  writes: TranslationalStageWrite[];
  /** Items carrying a valid stage whose pmid is not in our publication table. */
  skippedMissingPublication: number;
  /** Items whose stage or confidence is present but not a value we know. They
   *  are skipped, not written: a changed spelling upstream must show up as a
   *  count in the log, and must never turn a hidden low-confidence stage into
   *  a displayable one by writing NULL over its confidence. */
  skippedUnrecognized: number;
};

const present = (v: unknown): boolean =>
  v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");

/**
 * One write per IMPACT# item that carries a valid stage and whose pmid we
 * have. Items with a missing or unrecognized stage are left out entirely.
 * A pmid seen twice keeps its last item (one IMPACT# item per pmid is the norm).
 */
export function buildTranslationalStageWrites(
  items: readonly ImpactStageInput[],
  knownPmids: ReadonlySet<string>,
): TranslationalStageWritePlan {
  const byPmid = new Map<string, TranslationalStageWrite>();
  let skippedMissingPublication = 0;
  let skippedUnrecognized = 0;
  for (const it of items) {
    const stage = parseTranslationalStage(it.translational_stage);
    if (!stage) {
      if (present(it.translational_stage)) skippedUnrecognized += 1;
      continue;
    }
    const confidence = parseTranslationalStageConfidence(it.translational_stage_confidence);
    if (!confidence && present(it.translational_stage_confidence)) {
      skippedUnrecognized += 1;
      continue;
    }
    const pmid = impactRecordPmid(it);
    if (!pmid) continue;
    if (!knownPmids.has(pmid)) {
      skippedMissingPublication += 1;
      continue;
    }
    byPmid.set(pmid, {
      pmid,
      translationalStage: stage,
      translationalStageConfidence: confidence,
    });
  }
  return { writes: [...byPmid.values()], skippedMissingPublication, skippedUnrecognized };
}

/**
 * Group writes by their (stage, confidence) pair so the caller can issue one
 * `updateMany ... WHERE pmid IN (...)` per pair and chunk, instead of one
 * statement per publication. At most 5 x 4 = 20 groups.
 */
export function groupTranslationalStageWrites(
  writes: readonly TranslationalStageWrite[],
): Array<{
  translationalStage: RawTranslationalStage;
  translationalStageConfidence: TranslationalStageConfidence | null;
  pmids: string[];
}> {
  const groups = new Map<
    string,
    {
      translationalStage: RawTranslationalStage;
      translationalStageConfidence: TranslationalStageConfidence | null;
      pmids: string[];
    }
  >();
  for (const w of writes) {
    const key = `${w.translationalStage}|${w.translationalStageConfidence ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        translationalStage: w.translationalStage,
        translationalStageConfidence: w.translationalStageConfidence,
        pmids: [],
      };
      groups.set(key, g);
    }
    g.pmids.push(w.pmid);
  }
  return [...groups.values()];
}
