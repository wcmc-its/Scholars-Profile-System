/**
 * "Translational stage" — where a paper sits on the bench-to-population
 * spectrum. ReCiterAI assigns it per publication with an AI model (from the
 * paper's synopsis or abstract) and writes it to the DynamoDB
 * `IMPACT#pmid_<pmid>` record; the DynamoDB ETL copies the raw values onto
 * `Publication.translationalStage` / `translationalStageConfidence`.
 *
 * Raw stage values are "T0" | "T1" | "T2" | "T3-4" | "NA". Only the four T
 * stages are ever shown, and only when the model was not unsure ("low"
 * confidence). The rule is applied at index time (`displayStage`), so it
 * re-tunes with a reindex, no ETL re-run. Pure and dependency-free
 * (client-safe for the label map).
 */

/** The displayable stages, in the fixed order every surface lists them. */
export const TRANSLATIONAL_STAGES = ["T0", "T1", "T2", "T3-4"] as const;
export type TranslationalStage = (typeof TRANSLATIONAL_STAGES)[number];

/** Every stage value ReCiterAI writes. "NA" = the paper does not fit the spectrum. */
export const RAW_TRANSLATIONAL_STAGES = [...TRANSLATIONAL_STAGES, "NA"] as const;
export type RawTranslationalStage = (typeof RAW_TRANSLATIONAL_STAGES)[number];

export const TRANSLATIONAL_STAGE_CONFIDENCES = ["high", "medium", "low"] as const;
export type TranslationalStageConfidence = (typeof TRANSLATIONAL_STAGE_CONFIDENCES)[number];

export const TRANSLATIONAL_STAGE_LABELS: Record<TranslationalStage, string> = {
  T0: "Basic research",
  T1: "Early translation",
  T2: "Clinical trials and efficacy",
  "T3-4": "Practice and population health",
};

/** One-line definitions, shared by the About page (`/about#translational-stage`,
 *  which prints them after "(T0): ") and the console's stage hovers, so the two
 *  cannot drift. Lower-case first letter as the About sentence reads; a hover
 *  shows it with `stageDefinition`. */
export const TRANSLATIONAL_STAGE_DEFINITIONS: Record<TranslationalStage, string> = {
  T0: "how biology and disease work, studied in cells, animals or models.",
  T1: "moving a discovery toward people, including first studies in humans.",
  T2: "testing whether an intervention works in patients.",
  "T3-4": "how care is delivered in practice and what it does for the health of populations.",
};

export const NO_STAGE_DEFINITION =
  "No stage is shown when the model is unsure, when the record does not fit this spectrum, or when ReCiterAI has not summarized it yet.";

/** A stage's definition as a stand-alone sentence ("T0" → "How biology…"). */
export function stageDefinition(s: TranslationalStage): string {
  const d = TRANSLATIONAL_STAGE_DEFINITIONS[s];
  return d.charAt(0).toUpperCase() + d.slice(1);
}

/** Whether a value is one of the four displayable stages. */
export function isTranslationalStage(v: unknown): v is TranslationalStage {
  return typeof v === "string" && (TRANSLATIONAL_STAGES as readonly string[]).includes(v);
}

/** Raw DynamoDB `translational_stage` → a known stage value, else null. Exact
 *  match only: an unknown spelling is dropped, never guessed at. */
export function parseTranslationalStage(v: unknown): RawTranslationalStage | null {
  return typeof v === "string" && (RAW_TRANSLATIONAL_STAGES as readonly string[]).includes(v)
    ? (v as RawTranslationalStage)
    : null;
}

/** Raw DynamoDB `translational_stage_confidence` → a known value, else null. */
export function parseTranslationalStageConfidence(v: unknown): TranslationalStageConfidence | null {
  return typeof v === "string" &&
    (TRANSLATIONAL_STAGE_CONFIDENCES as readonly string[]).includes(v)
    ? (v as TranslationalStageConfidence)
    : null;
}

/**
 * The stage to show for a publication, or null for none. Shown only when the
 * stage is one of the four T stages AND the confidence is not "low". "NA", a
 * missing or unknown stage, and low confidence all yield null. A valid stage
 * with no confidence recorded IS shown.
 */
export function displayStage(
  stage: string | null | undefined,
  confidence: string | null | undefined,
): TranslationalStage | null {
  if (!isTranslationalStage(stage)) return null;
  if (confidence === "low") return null;
  return stage;
}

/** "T0 · Basic research": the code first (the stages are ordered and the
 *  T-scheme is familiar), then the plain name. En dash in "T3–4". Unknown
 *  values pass through. */
export function translationalStageDisplay(v: string): string {
  return isTranslationalStage(v) ? `${v.replace("-", "\u2013")} · ${TRANSLATIONAL_STAGE_LABELS[v]}` : v;
}

/** Display label for a stage value; unknown values pass through. */
export function translationalStageLabel(v: string): string {
  return isTranslationalStage(v) ? TRANSLATIONAL_STAGE_LABELS[v] : v;
}

// Counts and shares by stage, with "none" for No stage (pure; reports 26 and
// the per-scholar Bibliometrics report share them).

export type StageBucket = TranslationalStage | "none";
export const STAGE_BUCKETS: readonly StageBucket[] = [...TRANSLATIONAL_STAGES, "none"];
export type StageCounts = Record<StageBucket, number>;

export const emptyCounts = (): StageCounts => ({ T0: 0, T1: 0, T2: 0, "T3-4": 0, none: 0 });
export const countsTotal = (c: StageCounts) => STAGE_BUCKETS.reduce((s, k) => s + c[k], 0);
export const countsIn = (c: StageCounts, stages: readonly TranslationalStage[]) =>
  stages.reduce((s, k) => s + c[k], 0);
export const stagedTotal = (c: StageCounts) => countsIn(c, TRANSLATIONAL_STAGES);

/** Exact shares (0–100) per bucket; all zero for an empty set. */
export function exactShares(c: StageCounts): StageCounts {
  const t = countsTotal(c);
  const out = emptyCounts();
  if (t > 0) for (const k of STAGE_BUCKETS) out[k] = (c[k] / t) * 100;
  return out;
}

/** Whole-percent shares of every bucket, No stage included, that add up to
 *  exactly 100 (largest remainder). All zero for an empty set. The reports
 *  show `stagedShares` instead; this stays for callers that want the mix of
 *  everything. */
export function roundedShares(c: StageCounts): StageCounts {
  const ex = exactShares(c);
  const out = emptyCounts();
  if (countsTotal(c) === 0) return out;
  let left = 100;
  for (const k of STAGE_BUCKETS) {
    out[k] = Math.floor(ex[k]);
    left -= out[k];
  }
  const order = [...STAGE_BUCKETS].sort((a, b) => ex[b] - Math.floor(ex[b]) - (ex[a] - Math.floor(ex[a])));
  for (let i = 0; i < left; i++) out[order[i]] += 1;
  return out;
}

export type StageShares = Record<TranslationalStage, number>;

/** Exact shares (0–100) of the four T stages among the STAGED records only:
 *  No stage is left out of the denominator. All zero when nothing is staged. */
export function exactStagedShares(c: StageCounts): StageShares {
  const t = stagedTotal(c);
  const out: StageShares = { T0: 0, T1: 0, T2: 0, "T3-4": 0 };
  if (t > 0) for (const k of TRANSLATIONAL_STAGES) out[k] = (c[k] / t) * 100;
  return out;
}

/** Whole-percent shares of the four T stages among staged records, adding up
 *  to exactly 100 (largest remainder). All zero when nothing is staged. How
 *  many records have a stage is a separate figure (`stageAssignedShare`), so a
 *  year with more unstaged records does not shrink every stage. */
export function stagedShares(c: StageCounts): StageShares {
  const ex = exactStagedShares(c);
  const out: StageShares = { T0: 0, T1: 0, T2: 0, "T3-4": 0 };
  if (stagedTotal(c) === 0) return out;
  let left = 100;
  for (const k of TRANSLATIONAL_STAGES) {
    out[k] = Math.floor(ex[k]);
    left -= out[k];
  }
  const order = [...TRANSLATIONAL_STAGES].sort((a, b) => ex[b] - Math.floor(ex[b]) - (ex[a] - Math.floor(ex[a])));
  for (let i = 0; i < left; i++) out[order[i]] += 1;
  return out;
}

/** The share (0–100, exact) of records that have a stage. 0 for an empty set. */
export function stageAssignedShare(c: StageCounts): number {
  const t = countsTotal(c);
  return t > 0 ? (stagedTotal(c) / t) * 100 : 0;
}

/** How a stage is counted, in report 26's Download and the Bibliometrics
 *  report's definitions. */
export const STAGE_RULE =
  "ReCiterAI assigns a translational stage from the abstract or summary. A stage counts only when the model was not unsure; low-confidence records and those outside the spectrum are under No stage. Shares are among records with a stage, so the four stages add up to 100%.";

/** The label for a paper with no displayable stage. */
export const NO_STAGE_LABEL = "No stage";

/**
 * A clinical trial's stage, from its trial phase (Paul, 2026-11-27 and
 * 11-28): early phase 1 and phase 1 are T1; phases 1/2, 2, 2/3 and 3 are T2;
 * phase 4 is T3–4. Anything else (not applicable, observational, expanded
 * access, unregistered, an unusual combination such as 1/3) has no stage.
 * Takes the phase bucket `phaseKey` (`lib/edit/clinical-trials-report.ts`)
 * makes of the stored CT.gov value, so this file stays dependency-free.
 * Trial stages stay on trials: they never feed a publication's stage.
 */
const TRIAL_STAGE_BY_PHASE: Record<string, TranslationalStage> = {
  early1: "T1",
  "1": "T1",
  "1/2": "T2",
  "2": "T2",
  "2/3": "T2",
  "3": "T2",
  "4": "T3-4",
};

export function trialStageFromPhaseKey(key: string): TranslationalStage | null {
  return TRIAL_STAGE_BY_PHASE[key] ?? null;
}

export const TRIAL_STAGE_RULE =
  "A clinical trial's stage comes from its phase: Phase 1 (and early Phase 1) is T1, Phase 2 and 3 (and 1/2, 2/3) are T2, Phase 4 is T3–4. Observational, not-applicable and unregistered studies have no stage. Trial stages are counted apart from publications, never mixed into their shares.";
