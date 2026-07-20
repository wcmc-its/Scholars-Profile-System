/**
 * WCM news-mentions ETL.
 *
 * Run via `npm run etl:news`; wired into the weekly chain in cdk/lib/etl-stack.ts
 * (and etl/orchestrate.ts for the local prototype runner). One run does:
 *
 *   1. Scrape the WCM Research news feed for NEW articles (or read NEWS_SEED_PATH
 *      when set — the offline path for local dev and CI). Incremental: the crawl
 *      stops once a listing page is entirely already ingested. NEWS_BACKFILL=1
 *      walks the whole feed and re-reconciles every article.
 *   2. Build a scholar-name index and, per article, form mention rows:
 *        VIVO-linked cwid  -> status='published' (trusted identifier join)
 *        prose name match  -> status='pending'   (queued for /edit/news-queue)
 *   3. UPSERT preserving human review state. Unlike scholar_technology (which
 *      truncate-rebuilds), this table carries a review queue: a re-scrape must
 *      never revert an approve/reject/hide or resurrect a rejected row. So a row
 *      a human has touched (`entered_by_cwid` set) only ever has its article
 *      metadata refreshed; an ETL-owned row may auto-upgrade NAME->VIVO but is
 *      never downgraded and never deleted.
 *   4. Record the run in `etl_run` under source="News".
 *
 * Env:
 *   NEWS_SEED_PATH   read this JSON (ScrapedArticle[]) instead of scraping.
 *   NEWS_BACKFILL=1  ignore the already-ingested set; walk the full feed.
 *   NEWS_MAX_PAGES   listing-page ceiling for a backfill (default 400).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";
import { scrapeNews } from "./scrape";
import { buildNameIndex, detectMentions } from "./names";
import { parseSeed, type ScrapedArticle } from "./seed";

const SEED_PATH = process.env.NEWS_SEED_PATH;
const BACKFILL = process.env.NEWS_BACKFILL === "1";

type MentionUpsert = {
  cwid: string;
  url: string;
  title: string;
  publishedAt: Date | null;
  excerpt: string | null;
  thumbnailUrl: string | null;
  status: "published" | "pending";
  source: "VIVO" | "NAME";
  detectedName: string | null;
  likelihood: string | null;
  sourceRef: string | null;
};

async function recordRun(args: {
  status: "success" | "failed";
  rowsProcessed: number;
  errorMessage?: string;
}): Promise<void> {
  await db.write.etlRun.create({
    data: {
      source: "News",
      status: args.status,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
    },
  });
}

function readSeedFile(path: string): ScrapedArticle[] {
  const abs = resolve(process.cwd(), path);
  try {
    return parseSeed(readFileSync(abs, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`[News] seed missing at ${abs} — refusing to treat as empty`);
    }
    throw err;
  }
}

/** Turn scraped articles into (cwid, url) mention rows against the known roster. */
export function articlesToMentions(
  articles: ScrapedArticle[],
  scholars: {
    cwid: string;
    fullName: string;
    preferredName: string | null;
    primaryTitle: string | null;
    primaryDepartment: string | null;
  }[],
): MentionUpsert[] {
  const knownCwids = new Set(scholars.map((s) => s.cwid));
  const nameIndex = buildNameIndex(scholars);
  const byKey = new Map<string, MentionUpsert>();

  for (const a of articles) {
    const publishedAt = a.publishedAt ? new Date(`${a.publishedAt}T00:00:00Z`) : null;
    const meta = {
      url: a.url,
      title: a.title,
      publishedAt,
      excerpt: a.excerpt,
      thumbnailUrl: a.thumbnailUrl,
    };
    const put = (row: MentionUpsert) => {
      const k = `${row.cwid} ${row.url}`;
      if (!byKey.has(k)) byKey.set(k, row); // VIVO added before NAME, so VIVO wins a tie
    };

    for (const cwid of a.cwids) {
      if (!knownCwids.has(cwid)) continue; // departed faculty / non-scholar
      put({
        ...meta,
        cwid,
        status: "published",
        source: "VIVO",
        detectedName: null,
        likelihood: null,
        sourceRef: null,
      });
    }
    // detectMentions already excludes the VIVO cwids, so no scholar is both.
    for (const d of detectMentions(`${a.title} ${a.bodyText}`, nameIndex, new Set(a.cwids))) {
      put({
        ...meta,
        cwid: d.cwid,
        status: "pending",
        source: "NAME",
        detectedName: d.detectedName,
        likelihood: d.likelihood,
        sourceRef: `${a.url}|${d.groupKey}`,
      });
    }
  }
  return [...byKey.values()];
}

function sameDate(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

/** The subset of a stored row the reconcile decision needs. */
export type ExistingMention = {
  status: string;
  source: string;
  enteredByCwid: string | null;
  title: string;
  publishedAt: Date | null;
  excerpt: string | null;
  thumbnailUrl: string | null;
  detectedName: string | null;
  likelihood: string | null;
  sourceRef: string | null;
};

/**
 * Compute the update patch for an existing (cwid, url) row given a freshly
 * scraped mention. Empty patch => preserve as-is. Pure, so the review-state
 * discipline is unit-testable without a DB:
 *   - article metadata (title/date/excerpt/thumbnail) always refreshes;
 *   - a human-touched row (enteredByCwid set) NEVER changes status/source;
 *   - an ETL-owned row may upgrade NAME->VIVO (unless already rejected) but is
 *     never downgraded and never resurrected.
 */
export function reconcile(cur: ExistingMention, r: MentionUpsert): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (cur.title !== r.title) data.title = r.title;
  if (!sameDate(cur.publishedAt, r.publishedAt)) data.publishedAt = r.publishedAt;
  if (cur.excerpt !== r.excerpt) data.excerpt = r.excerpt;
  if (cur.thumbnailUrl !== r.thumbnailUrl) data.thumbnailUrl = r.thumbnailUrl;

  const humanTouched = cur.enteredByCwid !== null;
  if (!humanTouched) {
    if (r.source === "VIVO" && cur.source !== "VIVO" && cur.status !== "rejected") {
      data.source = "VIVO";
      data.status = "published";
      data.detectedName = null;
      data.likelihood = null;
      data.sourceRef = null;
    } else if (r.source === "NAME" && cur.source === "NAME") {
      if (cur.detectedName !== r.detectedName) data.detectedName = r.detectedName;
      if (cur.likelihood !== r.likelihood) data.likelihood = r.likelihood;
      if (cur.sourceRef !== r.sourceRef) data.sourceRef = r.sourceRef;
    }
    // NAME arriving for an existing VIVO row: keep VIVO, change nothing.
  }
  return data;
}

async function upsertMentions(rows: MentionUpsert[]): Promise<{
  inserted: number;
  updated: number;
  preserved: number;
}> {
  const urls = [...new Set(rows.map((r) => r.url))];
  const existing = urls.length
    ? await db.write.newsMention.findMany({
        where: { url: { in: urls } },
        select: {
          id: true,
          cwid: true,
          url: true,
          status: true,
          source: true,
          enteredByCwid: true,
          title: true,
          publishedAt: true,
          excerpt: true,
          thumbnailUrl: true,
          detectedName: true,
          likelihood: true,
          sourceRef: true,
        },
      })
    : [];
  const byKey = new Map(existing.map((e) => [`${e.cwid} ${e.url}`, e]));

  let inserted = 0;
  let updated = 0;
  let preserved = 0;

  await db.write.$transaction(
    async (tx) => {
      for (const r of rows) {
        const cur = byKey.get(`${r.cwid} ${r.url}`);
        if (!cur) {
          await tx.newsMention.create({
            data: {
              cwid: r.cwid,
              url: r.url,
              title: r.title,
              publishedAt: r.publishedAt,
              excerpt: r.excerpt,
              thumbnailUrl: r.thumbnailUrl,
              status: r.status,
              source: r.source,
              detectedName: r.detectedName,
              likelihood: r.likelihood,
              sourceRef: r.sourceRef,
              // enteredByCwid stays null: the ETL is not a manual edit.
            },
          });
          inserted++;
          continue;
        }

        const data = reconcile(cur, r);
        if (Object.keys(data).length > 0) {
          await tx.newsMention.update({ where: { id: cur.id }, data });
          updated++;
        } else {
          preserved++;
        }
      }
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 },
  );

  return { inserted, updated, preserved };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const scholars = await db.write.scholar.findMany({
    where: { deletedAt: null },
    select: {
      cwid: true,
      fullName: true,
      preferredName: true,
      primaryTitle: true,
      primaryDepartment: true,
    },
  });

  let articles: ScrapedArticle[];
  let source: string;
  if (SEED_PATH) {
    articles = readSeedFile(SEED_PATH);
    source = "seed";
  } else {
    const knownUrls = BACKFILL
      ? new Set<string>()
      : new Set(
          (await db.write.newsMention.findMany({ select: { url: true }, distinct: ["url"] })).map(
            (r) => r.url,
          ),
        );
    const maxPages = Number(process.env.NEWS_MAX_PAGES) || undefined;
    const result = await scrapeNews(knownUrls, { maxPages });
    // A crawl that fetched stubs but couldn't load their detail pages is the
    // site being down/rate-limiting, not "no news" — fail rather than record a
    // hollow success (the volume guard scholar_technology needs is unnecessary
    // here because we never delete, but a fetch collapse still must not pass).
    if (result.fetchFailed > Math.max(5, result.stubs * 0.2)) {
      throw new Error(
        `[News] ${result.fetchFailed}/${result.stubs} detail pages failed to fetch — WCM down or rate-limiting?`,
      );
    }
    articles = result.articles;
    source = "scrape";
  }

  const rows = articlesToMentions(articles, scholars);
  const { inserted, updated, preserved } = await upsertMentions(rows);
  await recordRun({ status: "success", rowsProcessed: inserted + updated });

  console.log(
    `[News] ${JSON.stringify({
      event: "news_etl_complete",
      source,
      articles: articles.length,
      mentions: rows.length,
      inserted,
      updated,
      preserved,
      pending: rows.filter((r) => r.status === "pending").length,
      durationMs: Date.now() - startedAt,
    })}`,
  );
}

// Only auto-run as a script, not when imported by tests.
if (process.env.NODE_ENV !== "test" && process.argv[1] && /etl[\\/]news[\\/]index/.test(process.argv[1])) {
  main()
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[News] ${JSON.stringify({ event: "fatal", error: message })}`);
      await recordRun({ status: "failed", rowsProcessed: 0, errorMessage: message }).catch(() => {});
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.write.$disconnect();
    });
}
