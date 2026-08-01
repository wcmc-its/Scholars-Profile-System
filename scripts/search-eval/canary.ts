/**
 * Post-deploy relevance canary (issue #1444 remainder).
 *
 * A fast smoke check the `deploy.yml` workflow runs right after a staging
 * roll: confirms the pinned top-anchors in `pins.json` (the same anchors
 * `compare.sh` checks against the full gold set) still rank where they
 * should in the JUST-DEPLOYED image. NOT the full eval — that stays a
 * separately-scoped nightly in-VPC run; this is deliberately ~2 queries so
 * it adds only seconds to the deploy.
 *
 * Runs in-VPC via `ecs run-task` on the `sps-search-eval-canary-<env>` task
 * (cdk/lib/app-stack.ts), reusing the deploy workflow's existing
 * OIDC-authenticated `ecs:RunTask` — not a new scheduled/always-on task.
 * GitHub-hosted runners sit off the WCM network and the staging/prod edge
 * WAF is WCM-CIDR-only (#1434), so a plain `curl` from the workflow itself
 * can't reach the deployed app; this script instead runs on an ECS task
 * inside the VPC and hits the PUBLIC ALB's DNS name directly — bypassing
 * CloudFront/the WAF entirely, which the issue calls out as a determinism
 * plus (no CloudFront cache in the way). The ALB's public listener still
 * gates on the X-Origin-Verify shared secret (B07); the task definition
 * injects it as CANARY_ORIGIN_VERIFY via its own dedicated, minimally
 * scoped execution role (reads only that one secret — never a DB DSN).
 *
 * Env:
 *   CANARY_HOST            e.g. http://<alb-dns>              (required)
 *   CANARY_ORIGIN_VERIFY   X-Origin-Verify header value        (required)
 *   CANARY_MAX_PAGES       pages fetched per query (default 5 = top 100)
 *
 * Exit 0 = every pin holds. Exit 1 = a pin regressed (missing or ranked
 * worse than its maxRank) — the deploy workflow step fails/alerts on this.
 * Exit 2 = the canary itself couldn't run (bad config, network error).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Pin = { q: string; cwid: string; maxRank: number; who: string };

type Hit = { cwid: string; relevanceScore: number };

type SearchResponse = { total?: number; hits?: Hit[] };

const HOST = process.env.CANARY_HOST;
const ORIGIN_VERIFY = process.env.CANARY_ORIGIN_VERIFY;
const MAX_PAGES = Number(process.env.CANARY_MAX_PAGES ?? 5);
const PAGE_SIZE = 20;

function loadPins(): Pin[] {
  const path = join(process.cwd(), "scripts/search-eval/pins.json");
  return JSON.parse(readFileSync(path, "utf8")) as Pin[];
}

/** Pages + dedupes + re-sorts by relevanceScore, mirroring lib.sh's fetch_combined
 *  — bounded to MAX_PAGES since a pin only needs the top handful of results. */
async function fetchTopHits(q: string): Promise<Hit[]> {
  const headers = { "X-Origin-Verify": ORIGIN_VERIFY as string };
  const enc = encodeURIComponent(q);
  const all: Hit[] = [];
  let pages = 1;
  for (let p = 0; p < pages && p < MAX_PAGES; p++) {
    const url = `${HOST}/api/search?type=people&q=${enc}&page=${p}&_cb=${Date.now()}${p}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`"${q}" page ${p}: HTTP ${res.status}`);
    }
    const body = (await res.json()) as SearchResponse;
    all.push(...(body.hits ?? []));
    if (p === 0) {
      pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil((body.total ?? 0) / PAGE_SIZE)));
    }
  }
  const byId = new Map<string, Hit>();
  for (const hit of all) {
    if (!byId.has(hit.cwid)) byId.set(hit.cwid, hit);
  }
  return [...byId.values()].sort((a, b) => b.relevanceScore - a.relevanceScore);
}

async function main(): Promise<void> {
  if (!HOST) {
    console.error("canary: CANARY_HOST is required");
    process.exit(2);
  }
  if (!ORIGIN_VERIFY) {
    console.error("canary: CANARY_ORIGIN_VERIFY is required");
    process.exit(2);
  }

  const pins = loadPins();
  console.log(`search-eval canary   host=${HOST}   pins=${pins.length}`);

  let breach = false;
  for (const pin of pins) {
    let rank: number | null = null;
    try {
      const sorted = await fetchTopHits(pin.q);
      const idx = sorted.findIndex((h) => h.cwid === pin.cwid);
      rank = idx === -1 ? null : idx + 1;
    } catch (err) {
      console.error(`   ${pin.q} -> ERROR: ${String(err)}`);
      breach = true;
      continue;
    }
    const ok = rank !== null && rank <= pin.maxRank;
    if (!ok) breach = true;
    console.log(
      `   ${pin.q} -> #${rank ?? "MISS"} (max #${pin.maxRank})  ${ok ? "ok" : "BREACH"}  — ${pin.who}`,
    );
  }

  console.log("════════════════════════════════════════");
  if (breach) {
    console.log("FAIL — pinned anchor breach (issue #1444)");
    process.exit(1);
  }
  console.log("PASS — pinned anchors hold");
}

main().catch((err) => {
  console.error(String(err));
  process.exit(2);
});
