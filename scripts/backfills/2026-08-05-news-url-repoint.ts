/**
 * Repoint `news_mention.url` from the WCM Research site to its WCM Newsroom
 * twin (#2232, one-shot per DB). Unblocks the fail-closed interlock #2231 put
 * in `etl/news/index.ts`.
 *
 * WHY AN UPDATE AND NOT A DELETE + REBUILD. `url` is half the row identity
 * (`@@unique([cwid, url])`), so the origin change re-keys the whole table. A
 * DELETE + `NEWS_BACKFILL=1` rebuild is far cheaper and is EQUIVALENT ONLY IF no
 * row carries human state — but a scholar's /edit hide lives as
 * `show_on_profile = false` and a reviewer's decision as `status` +
 * `entered_by_cwid`, both on the row being discarded. Rewriting in place is
 * correct whether or not that state exists, so it does not depend on a
 * measurement of it. (Staging measured 3 rows with `entered_by_cwid`; prod's
 * counts were never measured — `scripts/run-staging-probe.sh` is staging-only.)
 *
 * WHY NOT A STRING SUBSTITUTION. The two sites do not share a slug. They differ
 * on stopwords, among other things:
 *
 *   research: /about-us/news-updates/cancer-evolution-study-reveals-biology-glioma-progression
 *   newsroom: /news/2026/07/cancer-evolution-study-reveals-biology-of-glioma-progression
 *
 * so a `REPLACE()` produces plausible-looking dead links. The reliable mapping is
 * the canonical link every research article page prints back to the newsroom,
 * which resolved on 100% of 78 sampled articles. This script fetches each stored
 * url and reads that link.
 *
 * Idempotent: rows are selected by "url is not under the current NEWS_ORIGIN",
 * so a completed row is never revisited and a partial run resumes cleanly.
 *
 *   --dry-run    resolve and report; write nothing.
 *   --limit=N    cap the DISTINCT urls processed (sample against staging first).
 *   --concurrency=N  parallel fetches (default 4; be kind to the origin).
 *
 * Run (operator-driven, per scripts/backfills/README.md) — dry-run first:
 *   npx tsx scripts/backfills/2026-08-05-news-url-repoint.ts --dry-run
 *   npx tsx scripts/backfills/2026-08-05-news-url-repoint.ts
 *
 * AFTERWARDS: the first `etl:news` run following this migration is an ordinary
 * incremental delta, NOT a backfill — which is the point. Do not run
 * `NEWS_BACKFILL=1` right after it, or the big->small `etl_run` pair from #2200
 * re-forms and reds the weekly integrity gate plus the next Monday nightly.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { db } from "../../lib/db";
import { NEWS_ORIGIN, NEWS_PATH_PREFIX } from "../../etl/news/seed";

const log = (msg: string) => console.log(msg);

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1]) || 0;
const CONCURRENCY =
  Number(process.argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1]) || 4;

/**
 * The newsroom canonical an article page links back to, or null.
 *
 * Read ONLY from the article's "Source link" field — the `pane-node-field-source-link`
 * pane the research site renders to point at the newsroom original — or from the
 * self-labelled anchor that same field emits (visible text == href).
 *
 * There is deliberately NO general "any newsroom href" fallback (#2241). Article
 * bodies carry inline prose links to OTHER newsroom stories, and those appear
 * BEFORE the source-link pane in document order, so a loose match silently
 * returns a real-but-wrong article:
 *
 *   page:  "NIH Grant Aims for Childhood Vaccine Against HIV"
 *   prose: .../2024/08/childhood-hiv-vaccination-strategy-shows-promise-in-study  <- "Prior studies"
 *   prose: .../2025/08/the-quest-for-an-hiv-vaccine                               <- "research spanning"
 *   FIELD: .../2025/09/nih-grant-aims-for-childhood-vaccine-against-hiv           <- the answer
 *
 * The first version of this script took the first match and mis-mapped 53 of 139
 * staging urls (38%) to plausible, wrong, existing articles. An unresolved url is
 * reported and left under the old origin — loud and harmless. A wrong one is
 * silent and points a scholar's profile at someone else's story.
 *
 * Exported for tests.
 */
export function newsroomCanonical(html: string, origin: string = NEWS_ORIGIN): string | null {
  const esc = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const article = `${esc}/news/\\d{4}/\\d{2}/[A-Za-z0-9%._-]+`;

  // 1. The source-link pane itself.
  const pane = html.match(/pane-node-field-source-link[\s\S]{0,1500}/i)?.[0];
  const inPane = pane?.match(new RegExp(`href=["'](${article})["']`, "i"));
  if (inPane) return inPane[1];

  // 2. The same field under a different theme: an anchor whose visible text IS
  //    the url. Prose links never label themselves that way.
  const selfLabelled = html.match(
    new RegExp(`<a\\b[^>]*href=["'](${article})["'][^>]*>\\s*(?:<[^>]+>\\s*)*${esc}`, "i"),
  );
  if (selfLabelled) return selfLabelled[1];

  return null;
}

export type MergeableRow = {
  id: string;
  status: "published" | "pending" | "rejected";
  showOnProfile: boolean;
  enteredByCwid: string | null;
  createdAt: Date;
};

/**
 * Collapse rows that will share one (cwid, url) after the repoint.
 *
 * The research site republishes some stories, so two old urls can resolve to one
 * newsroom article. Skipping those would leave them under the old origin and the
 * #2231 interlock would never open, so they are merged — conservatively, such
 * that every human decision in the group survives: a hide anywhere wins, and
 * `rejected` is terminal so it outranks anything else. The winner is the
 * human-touched row, else the oldest, so re-runs pick the same one.
 *
 * Exported for tests.
 */
export function mergeGroup<T extends MergeableRow>(
  rows: T[],
): { winner: T; losers: T[]; status: T["status"]; showOnProfile: boolean; enteredByCwid: string | null } {
  const winner =
    rows.find((r) => r.enteredByCwid !== null) ??
    [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  return {
    winner,
    losers: rows.filter((r) => r.id !== winner.id),
    status: rows.some((r) => r.status === "rejected") ? "rejected" : winner.status,
    showOnProfile: rows.every((r) => r.showOnProfile),
    enteredByCwid: winner.enteredByCwid ?? rows.find((r) => r.enteredByCwid)?.enteredByCwid ?? null,
  };
}

/** Swap the url stem of a contested-group key `"<url>|<detectedName>"`. */
export function rewriteSourceRef(
  sourceRef: string | null,
  oldUrl: string,
  newUrl: string,
): string | null {
  if (sourceRef === null) return null;
  return sourceRef.startsWith(`${oldUrl}|`)
    ? `${newUrl}${sourceRef.slice(oldUrl.length)}`
    : sourceRef;
}

async function fetchPage(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "WCM-Scholars-ETL/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return null;
      if (res.ok) return await res.text();
    } catch {
      // transient — fall through to backoff
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  return null;
}

/** Run `worker` over `items` with a fixed number of parallel slots. */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const legacy = await db.write.newsMention.findMany({
    where: { NOT: { url: { startsWith: NEWS_ORIGIN + NEWS_PATH_PREFIX } } },
    select: {
      id: true,
      cwid: true,
      url: true,
      sourceRef: true,
      status: true,
      showOnProfile: true,
      enteredByCwid: true,
      createdAt: true,
    },
  });
  if (legacy.length === 0) {
    log("[news-repoint] no rows outside the current origin — nothing to do.");
    return;
  }

  const urls = [...new Set(legacy.map((r) => r.url))].sort();
  const targeted = LIMIT > 0 ? urls.slice(0, LIMIT) : urls;
  log(
    `[news-repoint] ${legacy.length} row(s) across ${urls.length} distinct url(s); ` +
      `processing ${targeted.length}${DRY_RUN ? " (DRY RUN)" : ""}`,
  );

  const resolved = new Map<string, string>();
  const unresolved: string[] = [];
  await mapPool(targeted, CONCURRENCY, async (url, i) => {
    const html = await fetchPage(url);
    const canonical = html === null ? null : newsroomCanonical(html);
    if (canonical) resolved.set(url, canonical);
    else unresolved.push(url);
    if ((i + 1) % 50 === 0) log(`[news-repoint]   resolved ${i + 1}/${targeted.length}…`);
  });
  log(`[news-repoint] resolved ${resolved.size}, unresolved ${unresolved.length}`);

  // The research site republishes some stories, so two old urls can resolve to
  // ONE newsroom article. Those rows collide on (cwid, url) and must be MERGED,
  // not skipped: skipping leaves them under the old origin, and the #2231
  // interlock would then never open. Measured on staging: 3 colliding targets
  // out of 144 urls.
  //
  // Different cwids sharing a target do NOT collide — the key is (cwid, url) —
  // so group by the pair, not by the url.
  const groups = new Map<string, typeof legacy>();
  for (const row of legacy) {
    const newUrl = resolved.get(row.url);
    if (!newUrl) continue;
    const key = `${row.cwid} ${newUrl}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  let updated = 0;
  let merged = 0;
  for (const [key, rows] of groups) {
    const newUrl = key.slice(key.indexOf(" ") + 1);
    const { winner, losers, status, showOnProfile, enteredByCwid } = mergeGroup(rows);

    if (losers.length > 0) {
      log(
        `[news-repoint] MERGE ${rows.length} rows -> ${newUrl} (${winner.cwid}; ` +
          `status=${status} showOnProfile=${showOnProfile})`,
      );
      merged += losers.length;
    }
    if (!DRY_RUN) {
      await db.write.$transaction(async (tx) => {
        if (losers.length > 0) {
          await tx.newsMention.deleteMany({ where: { id: { in: losers.map((l) => l.id) } } });
        }
        await tx.newsMention.update({
          where: { id: winner.id },
          data: {
            url: newUrl,
            sourceRef: rewriteSourceRef(winner.sourceRef, winner.url, newUrl),
            status,
            showOnProfile,
            enteredByCwid,
          },
        });
      });
    }
    updated++;
  }

  log(
    `[news-repoint] ${DRY_RUN ? "WOULD UPDATE" : "UPDATED"} ${updated} row(s); ` +
      `merged-away ${merged}; ${unresolved.length} url(s) unresolved`,
  );
  if (unresolved.length > 0) {
    log("[news-repoint] unresolved (left untouched — the ETL interlock stays CLOSED on these):");
    for (const u of unresolved.slice(0, 40)) log(`[news-repoint]     ${u}`);
    if (unresolved.length > 40) log(`[news-repoint]     …and ${unresolved.length - 40} more`);
    log("[news-repoint] resolve or retire those rows before etl:news can run.");
  } else if (!DRY_RUN) {
    log("[news-repoint] DONE — interlock should now pass; next etl:news is an ordinary delta.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => db.write.$disconnect());
}
