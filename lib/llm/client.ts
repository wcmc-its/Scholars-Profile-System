/**
 * Shared Bedrock client construction (#2123) — the single AWS SDK credential-
 * chain factory the overview generator, biosketch generator, Matcha concept
 * extraction, and the CV research-summary call each used to duplicate
 * byte-for-byte as their own private `xBedrock()` function.
 */
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

/** Lazily build a Bedrock client from the AWS credential chain (ECS task role
 *  in deployment, shell creds locally). Not memoized — construction is cheap
 *  and each caller controls its own call cadence. */
export function bedrockClient() {
  return createAmazonBedrock({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    credentialProvider: fromNodeProviderChain(),
  });
}

/**
 * Bedrock prompt-cache checkpoint (#2655). Set as a message's `providerOptions`
 * and the Converse request carries a `cachePoint` AFTER that message, so the
 * whole prefix up to it (system prompt, then a scholar payload) is written once
 * and read at ~0.1× input price on every later call within the 5-minute TTL
 * (writes cost 1.25×). Message-level only in the installed `@ai-sdk/amazon-bedrock`
 * (3.0.100): a part-level option is ignored. Silently a no-op when the prefix is
 * under the model minimum (1024 tokens on Opus 4.8 / Sonnet 4.5) — harmless, but it
 * spends one of the request's 4 checkpoints for nothing — so mark a prefix only when
 * it clears the minimum on at least one live path: the revise / product-mapping /
 * source-attribution system prompts are ~200-350 tokens and deliberately carry none,
 * while the verify system prompt keeps its mark for the biosketch permits path
 * (~1.6k tokens) even though the overview's default verifier (~0.8k) falls under.
 *
 * Reading the result: `usage.inputTokens` is the UNCACHED count — Bedrock, like the
 * Anthropic API, reports cache traffic beside it, not inside it (the #2655 measurement
 * run is where that reading gets confirmed). On the installed `ai` 6 /
 * `@ai-sdk/amazon-bedrock` 3 pair the read count is
 * `usage.inputTokenDetails.cacheReadTokens` and the write count survives only as
 * `providerMetadata.bedrock.usage.cacheWriteInputTokens` (the v2→v3 usage adapter drops
 * it). Nothing reads these yet; the pricing wiring lands with the measurement harness.
 */
export const BEDROCK_CACHE_POINT = { bedrock: { cachePoint: { type: "default" } } };
