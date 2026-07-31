/**
 * Bedrock display-only cost estimation (#2123, moved out of
 * `lib/edit/overview-prompt-versions.ts` where it was stranded next to the
 * prompt-version registry despite pricing every Bedrock caller, not just
 * overview drafts). Never used for routing.
 */

/** Per-MILLION-token Bedrock list prices (USD), keyed by model-family fragment. */
const MODEL_PRICE_PER_MTOK: { test: RegExp; input: number; output: number }[] = [
  { test: /claude-opus/i, input: 5, output: 25 },
  { test: /claude-sonnet/i, input: 3, output: 15 },
  { test: /claude-haiku/i, input: 1, output: 5 },
  { test: /claude-fable/i, input: 10, output: 50 },
];

/** Typical overview-draft token shape: profile facts in, short prose out. */
const OVERVIEW_DRAFT_INPUT_TOKENS = 5000;
const OVERVIEW_DRAFT_OUTPUT_TOKENS = 300;

/**
 * Generic best-effort USD estimate for one Bedrock call on `modelId` given an
 * input/output token shape; null when the model family is unrecognized. The
 * price lookup + arithmetic both `estimateDraftCostUsd` and
 * {@link estimateBiosketchCostUsd} share.
 */
export function estimateCostUsd(
  modelId: string,
  opts: { inputTokens: number; outputTokens: number },
): number | null {
  const p = MODEL_PRICE_PER_MTOK.find((x) => x.test.test(modelId));
  if (!p) return null;
  return (
    (opts.inputTokens / 1_000_000) * p.input +
    (opts.outputTokens / 1_000_000) * p.output
  );
}

/** Best-effort USD estimate for ONE draft on `modelId`; null when the model is
 *  unrecognized. A grounding (faithfulness) pass, when enabled, multiplies this
 *  by roughly 3 (two extra Bedrock calls). */
export function estimateDraftCostUsd(modelId: string): number | null {
  return estimateCostUsd(modelId, {
    inputTokens: OVERVIEW_DRAFT_INPUT_TOKENS,
    outputTokens: OVERVIEW_DRAFT_OUTPUT_TOKENS,
  });
}

/** Typical NIH-biosketch output-token shapes (#917 v5). Input reuses the
 *  overview-draft FACTS payload size ({@link OVERVIEW_DRAFT_INPUT_TOKENS}). */
export const BIOSKETCH_CONTRIBUTIONS_OUTPUT_TOKENS = 1650; // 5×~330 words
export const BIOSKETCH_STATEMENT_OUTPUT_TOKENS = 770; // ~580 words

/** Best-effort USD estimate for ONE NIH-biosketch generation on `modelId` for
 *  the given `mode`; null when the model is unrecognized. As with
 *  {@link estimateDraftCostUsd}, a faithfulness pass (when enabled) multiplies
 *  this by roughly 3 (two extra Bedrock calls). */
export function estimateBiosketchCostUsd(
  modelId: string,
  mode: "contributions" | "personal_statement",
): number | null {
  return estimateCostUsd(modelId, {
    inputTokens: OVERVIEW_DRAFT_INPUT_TOKENS,
    outputTokens:
      mode === "contributions"
        ? BIOSKETCH_CONTRIBUTIONS_OUTPUT_TOKENS
        : BIOSKETCH_STATEMENT_OUTPUT_TOKENS,
  });
}
