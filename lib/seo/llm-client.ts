/**
 * The single network-touching module for the LLM citation-RAG instrument —
 * mirrors `fetchSerpResult` being the only network fn in `serpapi.ts`. It maps
 * a "surface" (Perplexity / ChatGPT-Search / Gemini-grounded) to a concrete
 * `provider/model` string routed through the Vercel AI Gateway, and normalizes
 * whatever each provider returns into a uniform `{ prose, citedUrls }` answer.
 *
 * Adding a provider is one entry in `CITATION_PROVIDERS` — that is the whole
 * point of routing through the gateway with bare `provider/model` strings: no
 * per-provider client wiring, and per-call cost is observable via the gateway.
 *
 * Auth: the AI SDK gateway reads `AI_GATEWAY_API_KEY` from the environment
 * itself; `gatewayKeyFromEnv` only fails fast with a clear message (and never
 * logs the value) so a keyless `--dry-run` is impossible to confuse with a
 * misconfigured live run.
 */
import { generateText, stepCountIs, type ToolSet } from "ai";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";

import { citedUrlsFromSources, type CitedUrl } from "./llm-rank";

/** One citation-RAG surface: a pinned model + how it is told to search. */
export interface ProviderSpec {
  /** Short key used in snapshots/flags, e.g. "perplexity". */
  key: string;
  /** Gateway `provider/model` string, e.g. "perplexity/sonar". */
  model: string;
  /** Known model release/snapshot date, or null if the provider doesn't pin one. */
  modelDate: string | null;
  /**
   * Provider-executed search tool(s) to attach, or undefined when search is
   * built into the model (Perplexity). Tool DEFINITIONS come from the provider
   * packages even though the model call itself routes through the gateway.
   */
  buildTools?: () => ToolSet;
  /**
   * Indicative list price per answer in USD — used ONLY by the dry-run cost
   * estimate, never billed. The precise figure comes from the gateway's
   * per-generation lookup after a live run.
   */
  costPerCallUsd: number;
}

/**
 * The citation-RAG provider catalog. ADD A PROVIDER HERE (one entry).
 *
 * Model strings are pinned but operator-tunable: verify them against the live
 * gateway model list before a run (`docs/seo-llm-rank-tracking.md`), since model
 * ids roll forward. Perplexity searches natively (no tool); OpenAI and Gemini
 * need their provider-executed web-search / grounding tools attached.
 */
export const CITATION_PROVIDERS: ProviderSpec[] = [
  {
    key: "perplexity",
    model: "perplexity/sonar",
    modelDate: null,
    costPerCallUsd: 0.005,
  },
  {
    key: "openai",
    model: "openai/gpt-5.1",
    modelDate: null,
    buildTools: () => ({ web_search: openai.tools.webSearch({}) }),
    costPerCallUsd: 0.01,
  },
  {
    key: "google",
    model: "google/gemini-2.5-flash",
    modelDate: null,
    buildTools: () => ({ google_search: google.tools.googleSearch({}) }),
    costPerCallUsd: 0.035,
  },
];

/** Resolve a comma-separated provider selection against the catalog. */
export function selectProviders(keys: string[] | null): ProviderSpec[] {
  if (!keys || keys.length === 0) return CITATION_PROVIDERS;
  const byKey = new Map(CITATION_PROVIDERS.map((p) => [p.key, p]));
  return keys.map((k) => {
    const spec = byKey.get(k);
    if (!spec) {
      throw new Error(
        `Unknown provider ${JSON.stringify(k)}. Known: ${CITATION_PROVIDERS.map((p) => p.key).join(", ")}`,
      );
    }
    return spec;
  });
}

/** A provider's answer, normalized across surfaces. */
export interface LlmAnswer {
  prose: string;
  citedUrls: CitedUrl[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** AI Gateway generation id for an optional cost lookup, or null. */
  generationId: string | null;
}

/**
 * Execute one answer for `prompt` against `spec`. Network call. Tool-using
 * surfaces get a bounded `stopWhen` so the model completes the search→answer
 * loop (and thus populates `sources`) rather than stopping at the tool call.
 * The gateway key is read from the environment by the SDK, not passed here.
 */
export async function callProvider(
  spec: ProviderSpec,
  prompt: string,
  temperature: number,
  maxSteps = 5,
): Promise<LlmAnswer> {
  const tools = spec.buildTools?.();
  const result = await generateText({
    model: spec.model,
    prompt,
    temperature,
    ...(tools ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),
  });

  const gateway = (
    result.providerMetadata as Record<string, { generationId?: unknown }> | undefined
  )?.gateway;
  const generationId = typeof gateway?.generationId === "string" ? gateway.generationId : null;

  return {
    prose: result.text,
    citedUrls: citedUrlsFromSources(result.sources),
    usage: result.usage
      ? {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        }
      : undefined,
    generationId,
  };
}

/**
 * Confirm the gateway key is present, with a clear, secret-free error. The SDK
 * uses the env var directly — this is a fail-fast guard so the live path never
 * silently no-ops. `--dry-run` must never call this.
 */
export function gatewayKeyFromEnv(env: Record<string, string | undefined> = process.env): string {
  const key = env.AI_GATEWAY_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "AI_GATEWAY_API_KEY is not set. Export it in your shell before a live citation-RAG run. " +
        "Use --dry-run to validate the basket and estimate cost without it.",
    );
  }
  return key;
}
