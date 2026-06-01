/**
 * Types + pure transforms for the LLM citation-RAG rank instrument — the
 * AI-assistant companion to the Google-rank tracker in `serpapi.ts` /
 * `rank-basket.ts` (see `docs/seo-llm-rank-tracking.md`).
 *
 * Where the Google tracker asks "what organic position does a WCM profile hold
 * for query Q", this asks "when Perplexity / ChatGPT-Search / Gemini-grounded
 * answer the funder question 'who is an expert on Q', do they CITE a WCM
 * profile, and at what citation index". A citation-RAG answer is a prose blob
 * plus an ordered list of cited source URLs; "rank" here is the 1-based index
 * of the first cited URL that belongs to a tracked target.
 *
 * Two properties of LLM answers force a different shape than the SERP tracker:
 *   1. Non-determinism — the same query, sampled twice, can cite different
 *      sources. So we never report a single position; we sample N times and
 *      report a citation RATE with a 95% confidence interval (Wilson).
 *   2. Model drift — a "citation rate" is only comparable against the same
 *      model at the same date. Every snapshot pins {provider, model, modelDate,
 *      temperature, samples, queryBasketSha}; a diff across mismatched pins is
 *      FLAGGED, never silently compared.
 *
 * Everything in this module is PURE and network-free (the only network code is
 * `llm-client.ts`, mirroring `fetchSerpResult` being the sole network fn in
 * `serpapi.ts`), so the parsing/aggregation/CI logic is unit-tested without
 * spending a single API call.
 */
import { createHash } from "node:crypto";

import { hostMatches, pathMatches } from "./serpapi";
import type { BasketTarget } from "./rank-basket";

/** A cited URL extracted from one LLM answer, in citation order. */
export interface CitedUrl {
  url: string;
  title: string | null;
}

/** Where a target landed within ONE answer's ordered citation list. */
export interface CitationPlacement {
  /** 1-based index into the answer's cited-URL list, or null if not cited. */
  citationIndex: number | null;
  /** The matching cited URL (for spot-checking), or null. */
  url: string | null;
  /** The matching citation title, or null. */
  title: string | null;
}

/**
 * Normalize an AI SDK `result.sources` array into an ordered `CitedUrl[]`.
 *
 * The AI SDK exposes a unified `sources` array across providers, but the URL
 * source object's shape has shifted across versions (`sourceType: "url"` vs
 * `type: "url"`), and grounding/web-search results occasionally include
 * non-URL sources. We defensively keep any source that carries a string `url`
 * and is not explicitly tagged as a non-URL kind, preserving citation order.
 */
export function citedUrlsFromSources(
  sources:
    | Array<{ sourceType?: string; type?: string; url?: string; title?: string | null }>
    | undefined,
): CitedUrl[] {
  const out: CitedUrl[] = [];
  for (const s of sources ?? []) {
    const url = typeof s?.url === "string" ? s.url : undefined;
    if (!url) continue;
    const kind = s.sourceType ?? s.type;
    if (kind !== undefined && kind !== "url") continue;
    out.push({ url, title: s.title ?? null });
  }
  return out;
}

/**
 * Best (lowest-index) citation placement of `targets` within an ordered
 * `citedUrls` list. Mirrors `findDomainRank`: `targets` may be one host or an
 * array of host aliases of the same property, and an optional `pathPrefix`
 * restricts matches to URLs whose path starts with it (Penn's `/apps/faculty/`).
 * The 1-based index is the answer's citation order, which the SDK preserves.
 */
export function findCitationPlacement(
  citedUrls: CitedUrl[] | undefined,
  targets: string | string[],
  pathPrefix?: string,
): CitationPlacement {
  const hosts = Array.isArray(targets) ? targets : [targets];
  const list = citedUrls ?? [];
  for (let i = 0; i < list.length; i++) {
    const { url, title } = list[i];
    if (!hosts.some((h) => hostMatches(url, h))) continue;
    if (!pathMatches(url, pathPrefix)) continue;
    return { citationIndex: i + 1, url, title };
  }
  return { citationIndex: null, url: null, title: null };
}

// ── confidence interval ─────────────────────────────────────────────────────

/** A binomial proportion with its 95% confidence bounds. */
export interface RateCI {
  rate: number;
  lower: number;
  upper: number;
}

/**
 * Wilson score interval for a binomial proportion. Preferred over the normal
 * approximation because it stays inside [0, 1] and behaves sensibly at the
 * small N (default 3 samples) and near-0/near-1 rates this instrument hits
 * constantly. `z = 1.959963985` is the two-sided 95% critical value. `n = 0`
 * yields all-zero (no evidence either way).
 */
export function wilsonInterval(successes: number, n: number, z = 1.959963985): RateCI {
  if (n <= 0) return { rate: 0, lower: 0, upper: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { rate: p, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

// ── basket provenance ───────────────────────────────────────────────────────

/**
 * Stable 12-char fingerprint of the query basket (the ordered list of query
 * strings). Recorded in every run's metadata so a diff can tell whether two
 * snapshots even asked the same questions. Order-sensitive by design — a
 * reordered basket is a different basket.
 */
export function basketSha(queries: Array<{ query: string }>): string {
  const payload = JSON.stringify(queries.map((q) => q.query));
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

// ── snapshot shape (non-determinism controls baked in) ──────────────────────

/** Pinned run identity — the §4 drift controls. One per provider per snapshot. */
export interface LlmRunMeta {
  /** Provider key, e.g. "perplexity" | "openai" | "google". */
  provider: string;
  /** Resolved model string, e.g. "perplexity/sonar". */
  model: string;
  /** Known model release/snapshot date, or null if the provider doesn't pin one. */
  modelDate: string | null;
  temperature: number;
  /** N — samples per query for this provider. */
  samples: number;
  /** Fingerprint of the query basket this run consumed (see basketSha). */
  queryBasketSha: string;
  surface: "citation-rag";
}

/** Per-target placement within one sampled answer. */
export interface SamplePlacement extends CitationPlacement {
  targetKey: string;
}

/** One sampled answer for one (query, provider), kept raw for auditability. */
export interface LlmSample {
  sampleIndex: number;
  citedUrls: CitedUrl[];
  placements: SamplePlacement[];
  /** Token usage if the SDK reported it (cost is a separate gateway lookup). */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** AI Gateway generation id (`gen_…`) for an optional cost lookup. */
  generationId?: string | null;
}

/** Aggregate over N samples for one (query, target). */
export interface TargetRate extends RateCI {
  targetKey: string;
  /** Samples that cited this target. */
  citedCount: number;
  /** N — total samples. */
  samples: number;
  /** Median 1-based citation index among the samples that cited it. */
  medianCitationIndex: number | null;
}

/** Aggregated result for one (query, provider). */
export interface LlmRankRow {
  id: string;
  query: string;
  label?: string;
  provider: string;
  perTarget: TargetRate[];
  /** Raw per-sample records (snapshot is gitignored, so keep them). */
  rawSamples: LlmSample[];
}

export interface LlmRankSnapshot {
  /** ISO timestamp the run started. */
  capturedAt: string;
  /** The basket file this run consumed (path, for provenance). */
  basketSource: string;
  /** Echo of the targets, so a report can label without the basket. */
  targets: BasketTarget[];
  /** One pinned-identity entry per provider in this snapshot (§4). */
  runs: LlmRunMeta[];
  rows: LlmRankRow[];
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Roll N samples up into one row: per target, count the samples that cited it,
 * turn that into a Wilson rate+CI, and take the median citation index among the
 * citing samples. Pure — the script computes each sample's placements (via
 * `findCitationPlacement`); this only aggregates them.
 */
export function aggregateSamples(
  id: string,
  query: string,
  label: string | undefined,
  provider: string,
  targets: BasketTarget[],
  samples: LlmSample[],
): LlmRankRow {
  const n = samples.length;
  const perTarget: TargetRate[] = targets.map((t) => {
    const indices: number[] = [];
    for (const s of samples) {
      const p = s.placements.find((x) => x.targetKey === t.key);
      if (p && p.citationIndex !== null) indices.push(p.citationIndex);
    }
    const citedCount = indices.length;
    const ci = wilsonInterval(citedCount, n);
    return {
      targetKey: t.key,
      citedCount,
      samples: n,
      medianCitationIndex: median(indices),
      ...ci,
    };
  });
  return { id, query, label, provider, perTarget, rawSamples: samples };
}

// ── drift detection (§4: flag, never silently compare) ──────────────────────

export interface VersionMismatch {
  provider: string;
  field: "model" | "modelDate" | "temperature" | "samples" | "queryBasketSha";
  before: string;
  after: string;
}

/**
 * Compare the pinned run identities of two snapshots and FLAG every field that
 * differs for a provider present in both. The caller surfaces these as a
 * warning; a citation-rate diff across a changed model or basket is misleading,
 * so we never throw — we let the human decide, with the mismatch in plain view.
 */
export function detectVersionMismatches(
  before: LlmRankSnapshot,
  after: LlmRankSnapshot,
): VersionMismatch[] {
  const beforeByProvider = new Map(before.runs.map((r) => [r.provider, r]));
  const out: VersionMismatch[] = [];
  const fields: VersionMismatch["field"][] = [
    "model",
    "modelDate",
    "temperature",
    "samples",
    "queryBasketSha",
  ];
  for (const a of after.runs) {
    const b = beforeByProvider.get(a.provider);
    if (!b) continue; // provider not in both — not a mismatch, just incomparable
    for (const field of fields) {
      if (String(b[field]) !== String(a[field])) {
        out.push({
          provider: a.provider,
          field,
          before: String(b[field]),
          after: String(a[field]),
        });
      }
    }
  }
  return out;
}

// ── cost estimation (dry-run) ───────────────────────────────────────────────

/** Indicative per-call cost for one provider (see llm-client.ts catalog). */
export interface CostInput {
  key: string;
  costPerCallUsd: number;
}

export interface CostEstimate {
  numQueries: number;
  samples: number;
  /** queries × providers × samples — the LLM cost model. */
  totalCalls: number;
  perProvider: { key: string; calls: number; costUsd: number }[];
  totalCostUsd: number;
}

/**
 * Estimate the spend of one citation-RAG run. The defining difference from the
 * SerpAPI tracker: SerpAPI's "one search covers all targets" rule does NOT hold
 * here — every (query, provider, sample) is its own billed answer, so calls =
 * queries × providers × samples. Costs are INDICATIVE (provider list prices,
 * not a billed amount); the precise figure comes from the gateway afterward.
 */
export function estimateLlmCost(
  numQueries: number,
  providers: CostInput[],
  samples: number,
): CostEstimate {
  const perProvider = providers.map((p) => {
    const calls = numQueries * samples;
    return { key: p.key, calls, costUsd: calls * p.costPerCallUsd };
  });
  return {
    numQueries,
    samples,
    totalCalls: numQueries * providers.length * samples,
    perProvider,
    totalCostUsd: perProvider.reduce((s, p) => s + p.costUsd, 0),
  };
}
