/**
 * Capture a PARAMETRIC-prose mention snapshot over the expert basket (#594 §3).
 *
 *   npm run seo:llm-mention -- --dry-run               # validate + cost, NO calls, NO key
 *   npm run seo:llm-mention                            # live (needs AI_GATEWAY_API_KEY)
 *   npm run seo:llm-mention -- --judge openai/gpt-5.1  # add the LLM-as-judge prominence rubric
 *   npm run seo:llm-mention -- --providers openai --limit 1 --samples 1
 *
 * Vanilla chat (NO web tools) for ChatGPT/Claude/Gemini: does the model, from
 * its training prior, NAME WCM (institution, or a rostered scholar) when asked
 * "who's an expert in X", and how prominently? Lags training cutoffs by months —
 * diagnostic, NOT a launch metric. N-sampled rate + 95% CI + pinned model
 * metadata, mirroring seo:llm-rank. Output (gitignored):
 * data/seo/snapshots/llm-mention-<timestamp>.json
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  aggregateMentionSamples,
  detectMention,
  type JudgedMention,
  type MentionRow,
  type MentionRunMeta,
  type MentionSample,
  type MentionSnapshot,
  type MentionTargets,
} from "@/lib/seo/llm-mention";
import { basketSha, estimateLlmCost } from "@/lib/seo/llm-rank";
import {
  callProvider,
  gatewayKeyFromEnv,
  selectProviders,
  PARAMETRIC_PROVIDERS,
  type ProviderSpec,
} from "@/lib/seo/llm-client";
import { throttleWaitMs } from "@/lib/seo/serpapi";
import type { Basket, BasketQuery } from "@/lib/seo/rank-basket";

const DATA_DIR = path.resolve(process.cwd(), "data", "seo");
const DEFAULT_QUERIES = path.join(DATA_DIR, "flagship-queries.json");
const DEFAULT_BASKET = path.join(DATA_DIR, "rank-basket.json");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");

const INSTITUTION_NAMES = [
  "Weill Cornell Medicine",
  "Weill Cornell Medical College",
  "Weill Cornell",
  "WCM",
];
const SCHOLARS_HOST = "scholars.weill.cornell.edu";
/** Peer institutions, for the deterministic prominence ranking. */
const COMPETITOR_NAMES = [
  "Harvard",
  "Stanford",
  "Yale",
  "Johns Hopkins",
  "UCSF",
  "Mayo Clinic",
  "Columbia",
  "University of Pennsylvania",
  "Penn",
  "Duke",
  "Vanderbilt",
  "Northwestern",
  "NYU",
  "Mount Sinai",
  "UCLA",
  "Emory",
  "MD Anderson",
  "Memorial Sloan Kettering",
  "Dana-Farber",
];

interface FlagshipInput {
  query: string;
  label?: string;
}

interface Args {
  queries: string;
  basket: string;
  roster: string | null;
  dryRun: boolean;
  providers: string[] | null;
  samples: number;
  temperature: number;
  judge: string | null;
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
    roster: get("--roster") ?? null,
    dryRun: argv.includes("--dry-run"),
    providers: providersRaw
      ? providersRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
    samples: Number(get("--samples") ?? 3),
    temperature: Number(get("--temperature") ?? 0),
    judge: get("--judge") ?? null,
    limit: limitRaw === undefined ? null : Number(limitRaw),
    delayMs: Number(get("--delay") ?? 800),
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

/**
 * Scholar roster for "a specific WCM scholar was named" detection. From
 * --roster (JSON string[]) if given, else the top-scholar names already in the
 * committed rank-basket.json branded queries (bounded, ~30). Empty → skipped.
 */
async function loadRoster(args: Args): Promise<string[]> {
  if (args.roster) {
    return JSON.parse(await fs.readFile(args.roster, "utf8")) as string[];
  }
  try {
    const basket = JSON.parse(await fs.readFile(args.basket, "utf8")) as Basket;
    return basket.queries
      .filter((q) => q.type === "branded" && q.label)
      .map((q) => q.label as string);
  } catch {
    return [];
  }
}

/** Parametric prompt — names people, NO instruction to browse or cite. */
function buildPrompt(query: string): string {
  return (
    `Who are the leading people for: "${query}"? ` +
    `Name specific researchers and the institution each is affiliated with.`
  );
}

/** Judge rubric → a 0–3 prominence score for WCM. */
function judgePrompt(query: string, answer: string): string {
  return (
    `An assistant was asked: "Who are the leading people for: ${query}?".\n\n` +
    `Its answer:\n"""\n${answer}\n"""\n\n` +
    `On a 0–3 scale, how prominently is Weill Cornell Medicine (WCM) featured?\n` +
    `0 = not mentioned at all\n1 = mentioned only in passing\n` +
    `2 = named as one of several institutions/experts\n3 = led with / given top billing\n` +
    `Reply with ONLY the single digit.`
  );
}

function parseJudgeScore(text: string): number | undefined {
  const m = text.match(/[0-3]/);
  return m ? Number(m[0]) : undefined;
}

function fsSafeTimestamp(): string {
  return new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

function shortErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0].slice(0, 200);
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let queries = await loadExpertQueries(args.queries);
  if (args.limit !== null) queries = queries.slice(0, args.limit);
  if (queries.length === 0) throw new Error(`No queries selected from ${args.queries}.`);

  const providers = selectProviders(args.providers, PARAMETRIC_PROVIDERS);
  const roster = await loadRoster(args);
  const sha = basketSha(queries);
  const targets: MentionTargets = {
    institutionNames: INSTITUTION_NAMES,
    scholarNames: roster,
    scholarsHost: SCHOLARS_HOST,
    competitorNames: COMPETITOR_NAMES,
  };

  if (args.dryRun) {
    // Judge (if set) adds one call per sample → double the answer calls.
    const callsPerProvider = args.judge ? args.samples * 2 : args.samples;
    const est = estimateLlmCost(
      queries.length,
      providers.map((p) => ({ key: p.key, costPerCallUsd: p.costPerCallUsd })),
      callsPerProvider,
    );
    console.log(`[seo:llm-mention] DRY RUN — no API calls, no AI_GATEWAY_API_KEY required.`);
    console.log(`  queries:   ${args.queries} (${queries.length} expert queries)`);
    console.log(
      `  providers: ${providers.map((p) => `${p.key} (${p.model})`).join("  |  ")} [vanilla, no web tools]`,
    );
    console.log(`  samples:   N=${args.samples}, temperature=${args.temperature}`);
    console.log(`  roster:    ${roster.length} scholar names (for scholar-named detection)`);
    console.log(`  judge:     ${args.judge ?? "(off)"}`);
    console.log(
      `  calls:     ~${est.totalCalls} (${queries.length} × ${providers.length} × ${callsPerProvider})` +
        (args.judge ? " incl. judge" : ""),
    );
    console.log(`  cost:      ~${usd(est.totalCostUsd)} indicative`);
    console.log(`  basketSha: ${sha}`);
    for (const q of queries.slice(0, 5)) console.log(`    [${q.type}] ${q.query}`);
    if (queries.length > 5) console.log(`    … and ${queries.length - 5} more`);
    return;
  }

  gatewayKeyFromEnv();
  const judgeSpec: ProviderSpec | null = args.judge
    ? { key: "judge", model: args.judge, modelDate: null, costPerCallUsd: 0 }
    : null;

  const capturedAt = new Date().toISOString();
  const out = args.out ?? path.join(SNAPSHOT_DIR, `llm-mention-${fsSafeTimestamp()}.json`);
  const runs: MentionRunMeta[] = providers.map((spec) => ({
    provider: spec.key,
    model: spec.model,
    modelDate: spec.modelDate,
    temperature: args.temperature,
    samples: args.samples,
    queryBasketSha: sha,
    surface: "parametric",
    judgeModel: args.judge,
  }));

  const rows: MentionRow[] = [];
  const callTimes = new Map<string, number[]>();
  let done = 0;
  let failedSamples = 0;
  const totalUnits = queries.length * providers.length;

  const writeSnapshot = async (): Promise<void> => {
    const snapshot: MentionSnapshot = { capturedAt, basketSource: args.queries, runs, rows };
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  };

  for (const q of queries) {
    const prompt = buildPrompt(q.query);
    for (const spec of providers) {
      const samples: MentionSample[] = [];
      for (let i = 0; i < args.samples; i++) {
        if (args.maxPerHour > 0) {
          const times = callTimes.get(spec.key) ?? [];
          const wait = throttleWaitMs(times, args.maxPerHour, Date.now());
          if (wait > 0) await sleep(wait);
          times.push(Date.now());
          callTimes.set(spec.key, times);
        }
        try {
          const answer = await withRetry(() => callProvider(spec, prompt, args.temperature));
          const result: JudgedMention = detectMention(answer.prose, targets);
          if (judgeSpec) {
            try {
              const j = await withRetry(() =>
                callProvider(judgeSpec, judgePrompt(q.query, answer.prose), 0),
              );
              result.judgeScore = parseJudgeScore(j.prose);
              result.judgeRationale = j.prose.slice(0, 300);
            } catch {
              /* judge is best-effort; detection still recorded */
            }
          }
          samples.push({
            sampleIndex: i,
            prose: answer.prose,
            result,
            usage: answer.usage,
            generationId: answer.generationId,
          });
        } catch (err) {
          failedSamples++;
          console.warn(
            `[seo:llm-mention] sample failed (${spec.key} / ${q.id} #${i}): ${shortErr(err)}`,
          );
        }
        await sleep(args.delayMs);
      }
      done++;
      if (samples.length > 0) {
        rows.push(aggregateMentionSamples(q.id, q.query, q.label, spec.key, samples));
      }
      await writeSnapshot();
      console.log(
        `[seo:llm-mention] ${done}/${totalUnits} units (rows=${rows.length}, failedSamples=${failedSamples})`,
      );
    }
  }

  await writeSnapshot();
  console.log(`[seo:llm-mention] wrote snapshot of ${rows.length} rows to ${out}`);
  if (failedSamples > 0) {
    console.warn(`[seo:llm-mention] WARNING: ${failedSamples} sample(s) failed after retries`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
