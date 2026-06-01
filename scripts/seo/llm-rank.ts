/**
 * Capture an LLM citation-RAG rank snapshot over the expert query basket.
 *
 *   npm run seo:llm-rank -- --dry-run                 # validate + estimate cost, NO API calls, NO key
 *   npm run seo:llm-rank                              # live run (needs AI_GATEWAY_API_KEY)
 *   npm run seo:llm-rank -- --providers perplexity    # one surface only
 *   npm run seo:llm-rank -- --limit 1 --samples 1     # cheap smoke test
 *
 * For each expert query we ask each citation-capable assistant (Perplexity,
 * ChatGPT-Search, Gemini-grounded) the funder/journalist question and inspect
 * the cited sources for a WCM profile. Because LLM answers are non-deterministic
 * we sample each (query, provider) N times and record a citation RATE + 95% CI
 * (never a single position), plus the pinned {provider, model, modelDate,
 * temperature, samples, queryBasketSha} so a later diff knows what it's
 * comparing (see `docs/seo-llm-rank-tracking.md`).
 *
 * Cost model — the defining difference from `seo:track`: SerpAPI's "one search
 * covers all targets" does NOT hold. Every (query, provider, sample) is its own
 * billed answer, so calls = queries × providers × samples. `--dry-run` prints
 * this and needs no key. Output: data/seo/snapshots/llm-rank-<timestamp>.json
 * (gitignored).
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  aggregateSamples,
  basketSha,
  estimateLlmCost,
  findCitationPlacement,
  type LlmRankSnapshot,
  type LlmRunMeta,
  type LlmSample,
  type SamplePlacement,
} from "@/lib/seo/llm-rank";
import {
  callProvider,
  gatewayKeyFromEnv,
  selectProviders,
  type ProviderSpec,
} from "@/lib/seo/llm-client";
import { throttleWaitMs } from "@/lib/seo/serpapi";
import type { Basket, BasketQuery, BasketTarget } from "@/lib/seo/rank-basket";

const DATA_DIR = path.resolve(process.cwd(), "data", "seo");
const DEFAULT_QUERIES = path.join(DATA_DIR, "flagship-queries.json");
const DEFAULT_BASKET = path.join(DATA_DIR, "rank-basket.json");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");

interface FlagshipInput {
  query: string;
  label?: string;
}

interface Args {
  queries: string;
  basket: string;
  dryRun: boolean;
  providers: string[] | null;
  samples: number;
  temperature: number;
  limit: number | null;
  delayMs: number;
  maxPerHour: number;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const providersRaw = get("--providers");
  const limitRaw = get("--limit");
  return {
    queries: get("--queries") ?? DEFAULT_QUERIES,
    basket: get("--basket") ?? DEFAULT_BASKET,
    dryRun: argv.includes("--dry-run"),
    providers: providersRaw
      ? providersRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
    samples: Number(get("--samples") ?? 3),
    temperature: Number(get("--temperature") ?? 0),
    limit: limitRaw === undefined ? null : Number(limitRaw),
    delayMs: Number(get("--delay") ?? 800),
    // Per-provider sliding-window cap. 0 = disabled (the small expert basket is
    // well under any provider's RPM, so this is off by default).
    maxPerHour: Number(get("--max-per-hour") ?? 0),
    out: get("--out") ?? null,
  };
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Load the expert basket (flagship-queries.json), mirroring build-basket ids. */
async function loadExpertQueries(file: string): Promise<BasketQuery[]> {
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as FlagshipInput[];
  return raw.map((f) => ({
    id: `flagship:${slugify(f.query)}`,
    query: f.query,
    type: "expert" as const,
    label: f.label,
    flagship: true,
  }));
}

/** Load just the tracking targets from a basket file (default: rank-basket.json). */
async function loadTargets(file: string): Promise<BasketTarget[]> {
  const basket = JSON.parse(await fs.readFile(file, "utf8")) as Basket;
  if (!Array.isArray(basket.targets) || basket.targets.length === 0) {
    throw new Error(`Basket ${file} has no targets to track.`);
  }
  return basket.targets;
}

/**
 * The question put to each assistant. Phrased to elicit a real web-grounded
 * answer naming people + institutions with citations — that's what makes the
 * cited-source list (and thus a WCM profile's citation index) meaningful.
 */
function buildPrompt(query: string): string {
  return (
    `Who are the leading people for: "${query}"? ` +
    `Name specific researchers and the institution each is affiliated with. ` +
    `Base your answer on current web sources and cite them.`
  );
}

function fsSafeTimestamp(): string {
  return new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(1000 * (i + 1)); // linear backoff
    }
  }
  throw lastErr;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let queries = await loadExpertQueries(args.queries);
  if (args.limit !== null) queries = queries.slice(0, args.limit);
  if (queries.length === 0) {
    throw new Error(`No queries selected from ${args.queries}.`);
  }
  const targets = await loadTargets(args.basket);
  const providers = selectProviders(args.providers);
  const sha = basketSha(queries);

  // ── Dry run: report the plan + estimated spend, make zero API calls. ──
  if (args.dryRun) {
    const est = estimateLlmCost(
      queries.length,
      providers.map((p) => ({ key: p.key, costPerCallUsd: p.costPerCallUsd })),
      args.samples,
    );
    console.log(`[seo:llm-rank] DRY RUN — no API calls, no AI_GATEWAY_API_KEY required.`);
    console.log(`  queries:   ${args.queries} (${queries.length} expert queries)`);
    console.log(
      `  targets:   ${targets.map((t) => `${t.label} [${t.hosts.join(", ")}]`).join("  |  ")} (from ${args.basket})`,
    );
    console.log(
      `  providers: ${providers.map((p) => `${p.key} (${p.model}${p.buildTools ? " + search tool" : ""})`).join("  |  ")}`,
    );
    console.log(`  samples:   N=${args.samples}, temperature=${args.temperature}`);
    console.log(
      `  calls:     ${queries.length} × ${providers.length} × ${args.samples} = ${est.totalCalls} LLM calls ` +
        `(NOT 1-per-query — each call is one billed answer)`,
    );
    console.log(
      `  cost:      ~${usd(est.totalCostUsd)} indicative (` +
        est.perProvider.map((p) => `${p.key} ${p.calls}×=${usd(p.costUsd)}`).join(", ") +
        `)`,
    );
    console.log(`  basketSha: ${sha}`);
    console.log(`  sample prompts:`);
    for (const q of queries.slice(0, 5)) console.log(`    [${q.type}] ${q.query}`);
    if (queries.length > 5) console.log(`    … and ${queries.length - 5} more`);
    return;
  }

  gatewayKeyFromEnv(); // fail fast (and secret-free) if the key is missing

  const rows: LlmRankSnapshot["rows"] = [];
  const callTimes = new Map<string, number[]>(); // per-provider sliding-window state
  let done = 0;
  const totalUnits = queries.length * providers.length;

  for (const q of queries) {
    const prompt = buildPrompt(q.query);
    for (const spec of providers) {
      const samples: LlmSample[] = [];
      for (let i = 0; i < args.samples; i++) {
        if (args.maxPerHour > 0) {
          const times = callTimes.get(spec.key) ?? [];
          const wait = throttleWaitMs(times, args.maxPerHour, Date.now());
          if (wait > 0) {
            console.log(
              `[seo:llm-rank] ${spec.key} per-hour cap (${args.maxPerHour}) reached — pausing ${Math.ceil(wait / 1000)}s`,
            );
            await sleep(wait);
          }
          times.push(Date.now());
          callTimes.set(spec.key, times);
        }
        const answer = await withRetry(() => callProvider(spec, prompt, args.temperature));
        const placements: SamplePlacement[] = targets.map((t) => ({
          targetKey: t.key,
          ...findCitationPlacement(answer.citedUrls, t.hosts, t.pathPrefix),
        }));
        samples.push({
          sampleIndex: i,
          citedUrls: answer.citedUrls,
          placements,
          usage: answer.usage,
          generationId: answer.generationId,
        });
        await sleep(args.delayMs);
      }
      rows.push(aggregateSamples(q.id, q.query, q.label, spec.key, targets, samples));
      done++;
      console.log(`[seo:llm-rank] ${done}/${totalUnits} (query × provider) units`);
    }
  }

  const runs: LlmRunMeta[] = providers.map((spec: ProviderSpec) => ({
    provider: spec.key,
    model: spec.model,
    modelDate: spec.modelDate,
    temperature: args.temperature,
    samples: args.samples,
    queryBasketSha: sha,
    surface: "citation-rag",
  }));

  const snapshot: LlmRankSnapshot = {
    capturedAt: new Date().toISOString(),
    basketSource: args.queries,
    targets,
    runs,
    rows,
  };

  const out = args.out ?? path.join(SNAPSHOT_DIR, `llm-rank-${fsSafeTimestamp()}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  console.log(`[seo:llm-rank] wrote snapshot of ${rows.length} rows to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
