/**
 * WCM news-mentions ETL.
 *
 * Run via `npm run etl:news`; wired into the weekly chain in cdk/lib/etl-stack.ts
 * (and etl/orchestrate.ts for the local prototype runner). One run does:
 *
 *   1. Read the WCM Newsroom feed (news.weill.cornell.edu/news/feed.json) for NEW
 *      articles (or read NEWS_SEED_PATH when set — the offline path for local dev
 *      and CI). Incremental: the walk stops after the first feed page that is
 *      entirely already ingested. NEWS_BACKFILL=1 walks the whole feed and
 *      re-reconciles every article.
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
 *   NEWS_MAX_PAGES   feed-page ceiling for a backfill (default 60; 100 stories/page).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";
import { processStartedAt } from "@/lib/etl-run";
import { scrapeNews } from "./scrape";
import { buildNameIndex, detectMentions } from "./names";
import {
  NEWS_ORIGIN,
  NEWS_PATH_PREFIX,
  parseSeed,
  storyKey,
  type ScrapedArticle,
} from "./seed";

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
  /** How the NAME match was made — TAG|BODY|TITLE|CAPTION (#2578). Null for VIVO. */
  matchBasis: string | null;
  sourceRef: string | null;
  /** ~200-300 chars of raw article text around the matched name, for the queue
   *  UI (#2578 follow-up). Null for VIVO and for a NAME match with no prose
   *  position (TAG/CAPTION) — see DetectedMention.contextSnippet. */
  contextSnippet: string | null;
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
      startedAt: processStartedAt,
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
      // #2241 — key on the STORY, not the url: the feed publishes some articles
      // twice under different slugs, and (cwid, url) sees those as two rows.
      // Falls back to the url when the article has no date to key on.
      const k = `${row.cwid} ${storyKey(row.title, row.publishedAt) ?? row.url}`;
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
        matchBasis: null,
        sourceRef: null,
        contextSnippet: null,
      });
    }
    // detectMentions already excludes the VIVO cwids, so no scholar is both.
    for (const d of detectMentions(
      // #2578 — the feed's own tags are the strongest signal and the photo alt
      // text the weakest, so all three streams are kept SEPARATE here; merging
      // them into one blob would erase the basis the tiering is built on.
      // `title` rides ALONGSIDE `text` (not instead of it) — #2578 follow-up's
      // BODY score needs to know where the headline ends in the combined
      // stream; see MentionSources.title.
      { title: a.title, text: `${a.title} ${a.bodyText}`, tags: a.tags, captionText: a.captionText },
      nameIndex,
      new Set(a.cwids),
    )) {
      put({
        ...meta,
        cwid: d.cwid,
        status: "pending",
        source: "NAME",
        detectedName: d.detectedName,
        likelihood: d.likelihood,
        matchBasis: d.basis,
        sourceRef: `${a.url}|${d.groupKey}`,
        contextSnippet: d.contextSnippet,
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
  matchBasis: string | null;
  sourceRef: string | null;
  /** #2578 follow-up — same review-state discipline as detectedName/likelihood/
   *  matchBasis: refreshed on a NAME->NAME re-scrape, cleared on a VIVO upgrade,
   *  never touched on a human-touched row. */
  contextSnippet: string | null;
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
      // The whole NAME provenance set clears together — a stale basis on a row
      // now joined by identifier would tell the queue a story that isn't true.
      data.matchBasis = null;
      data.sourceRef = null;
      data.contextSnippet = null;
    } else if (r.source === "NAME" && cur.source === "NAME") {
      if (cur.detectedName !== r.detectedName) data.detectedName = r.detectedName;
      if (cur.likelihood !== r.likelihood) data.likelihood = r.likelihood;
      if (cur.matchBasis !== r.matchBasis) data.matchBasis = r.matchBasis;
      if (cur.sourceRef !== r.sourceRef) data.sourceRef = r.sourceRef;
      if (cur.contextSnippet !== r.contextSnippet) data.contextSnippet = r.contextSnippet;
    }
    // NAME arriving for an existing VIVO row: keep VIVO, change nothing.
  }
  return data;
}

async function upsertMentions(rows: MentionUpsert[]): Promise<{
  inserted: number;
  updated: number;
  preserved: number;
  deduped: number;
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
          matchBasis: true,
          sourceRef: true,
          contextSnippet: true,
        },
      })
    : [];
  const byKey = new Map(existing.map((e) => [`${e.cwid} ${e.url}`, e]));

  // #2241 — the batch is deduped by story, but a run only ever loads `existing`
  // by URL, so a story already stored under the feed's OTHER slug is invisible
  // here and would be created a second time. Look the affected scholars up by
  // story key as well, and skip a create that would duplicate one.
  const cwids = [...new Set(rows.map((r) => r.cwid))];
  /** `"<cwid> <storyKey>"` -> the urls this scholar already has it stored under. */
  const storedStories = new Map<string, Set<string>>();
  if (cwids.length) {
    for (const e of await db.write.newsMention.findMany({
      where: { cwid: { in: cwids } },
      select: { cwid: true, url: true, title: true, publishedAt: true },
    })) {
      const k = storyKey(e.title, e.publishedAt);
      if (!k) continue;
      const key = `${e.cwid} ${k}`;
      storedStories.set(key, (storedStories.get(key) ?? new Set()).add(e.url));
    }
  }
  /** True when this scholar already has the same story under a DIFFERENT url. */
  const storedElsewhere = (r: MentionUpsert): boolean => {
    const k = storyKey(r.title, r.publishedAt);
    if (!k) return false;
    const urlsForStory = storedStories.get(`${r.cwid} ${k}`);
    return urlsForStory !== undefined && !urlsForStory.has(r.url);
  };

  let inserted = 0;
  let updated = 0;
  let preserved = 0;
  let deduped = 0;

  await db.write.$transaction(
    async (tx) => {
      for (const r of rows) {
        const cur = byKey.get(`${r.cwid} ${r.url}`);
        if (!cur) {
          // #2241 — same story, other slug, already stored. Creating it would
          // render the article twice on the profile.
          if (storedElsewhere(r)) {
            deduped++;
            continue;
          }
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
              matchBasis: r.matchBasis,
              sourceRef: r.sourceRef,
              contextSnippet: r.contextSnippet,
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

  return { inserted, updated, preserved, deduped };
}

/**
 * Refuse to run while rows survive from a PREVIOUS NEWS_ORIGIN (#2200).
 *
 * `url` is half the row identity (`@@unique([cwid, url])`), so changing the
 * origin re-keys the whole table. Rows under the old origin become unreachable
 * — this ETL only ever touches urls the feed emits — and every article is
 * re-created under its new url. That is not merely duplicate profile entries:
 * a scholar's /edit hide lives as `showOnProfile=false` on the OLD row, and a
 * reviewer's `rejected` status likewise, so both silently revert to defaults.
 * reconcile()'s "never resurrect a rejected row" invariant is url-keyed and is
 * bypassed wholesale rather than violated.
 *
 * This is a code gate rather than a runbook line on purpose: NewsWeekly is a
 * scheduled Step Functions step and NEWS_ORIGIN is a hardcoded constant, not a
 * task-def flag — so there is no "merged but dark until cdk deploy" window in
 * which to do the data step. Merging alone would arm it.
 *
 * Clearing it means rewriting each `news_mention.url` (and the `source_ref`
 * stem) to its twin on the new origin. The slug is NOT a mechanical transform
 * — the sites differ on stopwords ("biology-glioma-progression" vs
 * "biology-of-glioma-progression") — so match on the canonical link each old
 * article page carries, not on a string substitution.
 */
export async function assertNoLegacyOriginRows(
  // db.write (the primary) deliberately: a lagging replica could report a
  // false all-clear and let the run proceed against un-migrated rows.
  countLegacy: () => Promise<number> = () =>
    db.write.newsMention.count({
      where: { NOT: { url: { startsWith: NEWS_ORIGIN + NEWS_PATH_PREFIX } } },
    }),
): Promise<void> {
  const legacy = await countLegacy();
  if (legacy === 0) return;
  throw new Error(
    `[News] ${legacy} news_mention row(s) predate the current source origin ` +
      `(${NEWS_ORIGIN}${NEWS_PATH_PREFIX}). Running now would re-create every ` +
      `article under a new url, reverting scholar hides and reviewer rejections. ` +
      `Migrate those rows to their twins on the new origin first (#2200).`,
  );
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  await assertNoLegacyOriginRows();
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
    // scrapeNews throws on an unreadable or empty feed, so a site outage or
    // rate-limit fails the run rather than recording a hollow success.
    articles = await scrapeNews(knownUrls, { maxPages });
    source = "scrape";
  }

  const rows = articlesToMentions(articles, scholars);
  const { inserted, updated, preserved, deduped } = await upsertMentions(rows);
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
      // #2241 — creates skipped because the scholar already has the story under
      // the feed's other slug. Logged so a silent rise is visible upstream drift.
      deduped,
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
