/**
 * Bedrock model ids + capability predicates (#2123). Two distinct defaults are
 * in use — DO NOT unify them into one constant, they are independent,
 * IAM-scoped rollback levers:
 *
 *   - `DEFAULT_GENERATE_MODEL` (Opus 5.5) — shared by the overview generator,
 *     the biosketch generator, and the CV research-summary call, via the
 *     `OVERVIEW_GENERATE_MODEL` / `BIOSKETCH_GENERATE_MODEL` env overrides.
 *   - `DEFAULT_EXTRACT_MODEL` (Sonnet 5.5) — Matcha concept extraction, the
 *     newsroom honors ETL, and the cancer-center funding classifier, via the
 *     `MATCHA_EXTRACT_MODEL` / `CANCER_FUNDING_MODEL` env overrides. Sonnet, not
 *     Opus, because a short structured extraction doesn't need Opus.
 *
 * Both ids are matched by an IAM resource glob — `TaskRoleBedrockPolicy` in
 * `cdk/lib/app-stack.ts` (opus-4-8, opus-5-5, sonnet-4-*, sonnet-5-5) and
 * `EtlTaskRoleBedrockPolicy` in `cdk/lib/etl-stack.ts` (sonnet-4-*, sonnet-5-5).
 * The previous generation (Opus 4.8 / Sonnet 4.5) stays granted so an env-var
 * rollback needs no cdk deploy; moving to any id OUTSIDE those globs does. Both
 * env var names are registered in `scripts/release/flag-parity-allowlist.txt`
 * as deliberately-not-wired-per-env rollback levers (unset ⇒ the default below
 * in every env) — do not rename either env var, and re-run the flag-parity gate
 * after touching this file.
 */
export const DEFAULT_GENERATE_MODEL = "us.anthropic.claude-opus-5-5";
export const DEFAULT_EXTRACT_MODEL = "us.anthropic.claude-sonnet-5-5";

/**
 * Opus 4.7 / 4.8, every 5.x model (Opus, Sonnet, Haiku), Fable and Mythos
 * REJECT an explicit `temperature` / `top_p` / `top_k` on Bedrock (HTTP 400; the
 * installed AI SDK strips it with a warning for the ids it knows). Gate the
 * param so those models run; the older models a rollback env var can point at
 * (Sonnet 4.x) keep their tuned temperature. `thinking` stays unset regardless:
 * 5.x thinks by default and rejects `{type:"disabled"}` / `budget_tokens`.
 */
export function modelAcceptsTemperature(modelId: string): boolean {
  return !/claude-(?:opus-4[-.][78]|(?:opus|sonnet|haiku)-[5-9]|fable|mythos)/.test(modelId);
}

/** `output_config.effort` levels. */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Whether `modelId` accepts `output_config.effort`: Opus 4.5+, Sonnet 4.6+, and
 * every 5.x / Fable / Mythos model. Sonnet 4.5 and Haiku 4.5 reject it, so the
 * rollback ids must not be sent one.
 */
export function modelAcceptsEffort(modelId: string): boolean {
  return /claude-(?:opus-4[-.][5-9]|sonnet-4[-.][6-9]|(?:opus|sonnet|haiku)-[5-9]|fable|mythos)/.test(
    modelId,
  );
}

/**
 * Call-level Bedrock provider options, spread into `generateText` /
 * `generateObject` (`...bedrockCallOptions(modelId, { effort })`).
 *
 * `effort` sets `output_config.effort` when the model accepts it (dropped for a
 * rollback id that doesn't). Opus 5.5 defaults to `medium` where Opus 4.8 ran at
 * `high`, so the generators pass `high` to keep quality; Sonnet 5.5 defaults to
 * `high` and THINKS by default (Sonnet 4.5 didn't), so the short extract/classify
 * calls pass `low` to hold latency and output budget near the no-thinking
 * baseline. Thinking tokens count toward `maxOutputTokens`.
 *
 * Structured output is deliberately left on the provider's `auto`: for 5.5 the
 * installed `@ai-sdk/amazon-bedrock` sends a prompt-injected JSON instruction
 * (never the forced `json` tool, which 5.5 rejects with a 400), and Sonnet 4.5
 * keeps native `output_config.format`. Pinning native `outputFormat` on Sonnet 5.5
 * was measured against live Bedrock and degenerated on about 1 call in 3 (a
 * single `{"term":"x"}` concept); `auto` returned the full extraction 6/6.
 */
export function bedrockCallOptions(
  modelId: string,
  opts: { effort?: ClaudeEffort },
): { providerOptions?: { bedrock: { reasoningConfig: { maxReasoningEffort: ClaudeEffort } } } } {
  if (!opts.effort || !modelAcceptsEffort(modelId)) return {};
  return { providerOptions: { bedrock: { reasoningConfig: { maxReasoningEffort: opts.effort } } } };
}

/**
 * `experimental_repairText` for `generateObject`. In prompt-injected JSON mode
 * Sonnet 5.5 sometimes closes a string with a curly quote (`…samples”}`), which
 * is an unterminated string to JSON.parse. Swap a curly quote that sits where a
 * closing quote must (before `,` `}` `]` or the end) and keep it only if it parses.
 */
export async function repairCurlyQuoteJson({ text }: { text: string }): Promise<string | null> {
  const fixed = text.replace(/[“”](?=\s*(?:[,}\]]|$))/g, '"');
  try {
    JSON.parse(fixed);
    return fixed;
  } catch {
    return null;
  }
}
