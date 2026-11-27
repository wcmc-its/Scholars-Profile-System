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

/** Whole-percent shares that add up to exactly 100 (largest remainder), so
 *  every row, column and chart the page draws sums to 100% with No stage. All
 *  zero for an empty set. */
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

/** How a stage is counted, in report 26's Download and the Bibliometrics
 *  report's definitions. */
export const STAGE_RULE =
  "ReCiterAI assigns a translational stage from the abstract or summary. A stage counts only when the model was not unsure; low-confidence records and those outside the spectrum are under No stage, so every row adds up to 100%.";

/** The label for a paper with no displayable stage. */
export const NO_STAGE_LABEL = "No stage";
