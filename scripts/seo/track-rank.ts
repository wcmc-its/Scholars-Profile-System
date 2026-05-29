/**
 * Capture a Google-rank snapshot for every query in the basket.
 *
 *   npm run seo:track -- --dry-run              # validate basket + estimate cost, NO API calls
 *   npm run seo:track                           # live run (needs SERPAPI_KEY)
 *   npm run seo:track -- --type topical         # only the topical queries
 *   npm run seo:track -- --limit 5 --no-cache   # cheap fresh test run
 *
 * One SerpAPI search per query covers ALL targets at once — the new Scholars
 * host and the legacy VIVO host are located in the same organic-results list —
 * so cost is (number of queries), not (queries × targets).
 *
 * Output: data/seo/snapshots/rank-<timestamp>.json (gitignored — SerpAPI
 * output is not committed). Re-run on the legacy domain BEFORE cutover and on
 * the new domain AFTER, then `npm run seo:diff`.
 *
 * The key is read from SERPAPI_KEY and never logged. --dry-run needs no key.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  fetchSerpResult,
  findDomainRank,
  serpApiKeyFromEnv,
  type SerpRequestOptions,
} from "@/lib/seo/serpapi";
import type {
  Basket,
  BasketQuery,
  QueryType,
  RankSnapshot,
  SnapshotRow,
} from "@/lib/seo/rank-basket";

const DEFAULT_BASKET = path.resolve(process.cwd(), "data", "seo", "rank-basket.json");
const SNAPSHOT_DIR = path.resolve(process.cwd(), "data", "seo", "snapshots");

interface Args {
  basket: string;
  dryRun: boolean;
  type: QueryType | "all";
  limit: number | null;
  delayMs: number;
  noCache: boolean;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const type = (get("--type") ?? "all") as Args["type"];
  if (!["all", "topical", "branded"].includes(type)) {
    throw new Error(`--type must be all|topical|branded, got ${type}`);
  }
  const limitRaw = get("--limit");
  return {
    basket: get("--basket") ?? DEFAULT_BASKET,
    dryRun: argv.includes("--dry-run"),
    type,
    limit: limitRaw === undefined ? null : Number(limitRaw),
    delayMs: Number(get("--delay") ?? 1200),
    noCache: argv.includes("--no-cache"),
    out: get("--out") ?? null,
  };
}

function selectQueries(basket: Basket, args: Args): BasketQuery[] {
  let qs = basket.queries;
  if (args.type !== "all") qs = qs.filter((q) => q.type === args.type);
  if (args.limit !== null) qs = qs.slice(0, args.limit);
  return qs;
}

function fsSafeTimestamp(): string {
  // 2026-05-29T13-45-02 — colon-free so it's a valid filename on every OS.
  return new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(
  query: string,
  apiKey: string,
  opts: SerpRequestOptions,
  attempts = 3,
): Promise<ReturnType<typeof fetchSerpResult>> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchSerpResult(query, apiKey, opts);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(1000 * (i + 1)); // linear backoff
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const basket = JSON.parse(await fs.readFile(args.basket, "utf8")) as Basket;
  const queries = selectQueries(basket, args);

  if (queries.length === 0) {
    throw new Error(`No queries selected from ${args.basket} (type=${args.type}).`);
  }

  // ── Dry run: report the plan and estimated spend, make zero API calls. ──
  if (args.dryRun) {
    const topical = queries.filter((q) => q.type === "topical").length;
    const branded = queries.filter((q) => q.type === "branded").length;
    console.log(`[seo:track] DRY RUN — no API calls, no SERPAPI_KEY required.`);
    console.log(`  basket:   ${args.basket} (generated ${basket.generatedAt})`);
    console.log(`  targets:  ${basket.targets.map((t) => `${t.label} [${t.hosts.join(", ")}]`).join("  |  ")}`);
    console.log(`  selected: ${queries.length} queries (${topical} topical, ${branded} branded)`);
    console.log(`  cost:     ~${queries.length} SerpAPI searches (1 per query; all targets share each search)`);
    console.log(`  sample:`);
    for (const q of queries.slice(0, 8)) {
      console.log(`    [${q.type}] ${q.query}`);
    }
    if (queries.length > 8) console.log(`    … and ${queries.length - 8} more`);
    return;
  }

  const apiKey = serpApiKeyFromEnv();
  const searchOpts: SerpRequestOptions = {
    country: basket.searchDefaults?.country,
    language: basket.searchDefaults?.language,
    googleDomain: basket.searchDefaults?.googleDomain,
    num: basket.searchDefaults?.num,
    location: basket.searchDefaults?.location,
    noCache: args.noCache,
  };

  const rows: SnapshotRow[] = [];
  let done = 0;
  for (const q of queries) {
    const res = await fetchWithRetry(q.query, apiKey, searchOpts);
    rows.push({
      id: q.id,
      query: q.query,
      type: q.type,
      topicId: q.topicId,
      label: q.label,
      placements: basket.targets.map((t) => ({
        targetKey: t.key,
        ...findDomainRank(res.organic_results, t.hosts),
      })),
    });
    done++;
    if (done % 10 === 0 || done === queries.length) {
      console.log(`[seo:track] ${done}/${queries.length} queries`);
    }
    if (done < queries.length) await sleep(args.delayMs);
  }

  const snapshot: RankSnapshot = {
    capturedAt: new Date().toISOString(),
    basketSource: args.basket,
    targets: basket.targets,
    searchDefaults: basket.searchDefaults,
    rows,
  };

  const out = args.out ?? path.join(SNAPSHOT_DIR, `rank-${fsSafeTimestamp()}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  console.log(`[seo:track] wrote snapshot of ${rows.length} queries to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
