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

/** Bedrock prompt-cache multipliers on the INPUT price (#2655): a read is ~0.1×,
 *  a 5-minute-TTL write is 1.25×. Same ratio for every Claude family, so they
 *  are not per-row in the table above. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Generic best-effort USD estimate for one Bedrock call on `modelId` given an
 * input/output token shape; null when the model family is unrecognized. The
 * price lookup + arithmetic both `estimateDraftCostUsd` and
 * {@link estimateBiosketchCostUsd} share.
 *
 * `inputTokens` is the UNCACHED count — Bedrock, like the Anthropic API, reports
 * cache traffic beside it, not inside it (the #2655 measurement run is where that
 * reading gets confirmed) — so a caller pricing a live `generateText` result passes
 * `usage.inputTokens` plus, from the installed `ai` 6 / `@ai-sdk/amazon-bedrock` 3
 * pair, `cacheReadTokens = usage.inputTokenDetails.cacheReadTokens` and
 * `cacheWriteTokens = providerMetadata.bedrock.usage.cacheWriteInputTokens` (the
 * v2→v3 usage adapter drops the write count, so it only survives in provider
 * metadata). Both default to 0, so the static console estimates are unchanged.
 */
export function estimateCostUsd(
  modelId: string,
  opts: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): number | null {
  const p = MODEL_PRICE_PER_MTOK.find((x) => x.test.test(modelId));
  if (!p) return null;
  return (
    (opts.inputTokens / 1_000_000) * p.input +
    ((opts.cacheReadTokens ?? 0) / 1_000_000) * p.input * CACHE_READ_MULTIPLIER +
    ((opts.cacheWriteTokens ?? 0) / 1_000_000) * p.input * CACHE_WRITE_MULTIPLIER +
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
