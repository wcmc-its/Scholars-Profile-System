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
