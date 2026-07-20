/**
 * Scrape the WCM Research news feed (research.weill.cornell.edu/about-us/news-updates).
 *
 * Attribution to a scholar comes first from the VIVO link an article prints
 * beside a faculty name (`vivo.weill.cornell.edu/display/cwid-<cwid>`), joined by
 * identifier — never by name. Articles that name a scholar in prose WITHOUT a
 * VIVO link are handled downstream by the name-dictionary matcher (names.ts),
 * which proposes a PENDING candidate for a human to confirm.
 *
 * Two page shapes:
 *   LISTING  ?page=N — 5 `view-teaser` cards per page: slug, title, excerpt,
 *            thumbnail. No date, no scholars. Sorted newest-first, so the weekly
 *            run crawls from page 0 and STOPS once a page is entirely already
 *            ingested (unlike the CTL scraper, which must walk the whole listing).
 *   DETAIL   the article page: publication date (`pane-node-created post-date`)
 *            and the body prose + faculty VIVO links (`pane-node-body`).
 *
 * ponytail: regexes over Drupal HTML because the feed exposes no structured
 * export. Shape assumptions are asserted, so a markup change surfaces as a failed
 * run (backfill) or an empty delta, never silent corruption. If WCM ships a JSON
 * feed, delete this and read it.
 */
import { NEWS_ORIGIN, type ScrapedArticle } from "./seed";
import { detectMentions, type NameIndexEntry } from "./names";

const LISTING = `${NEWS_ORIGIN}/about-us/news-updates`;

/** Hard ceiling on listing pages, so a pager bug can't spin forever. */
const MAX_LISTING_PAGES_DEFAULT = 400; // > the ~248 live pages, with margin

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

export type Fetcher = (url: string) => Promise<string | null>;

/** Fetch one page, or null when it is genuinely unavailable. Retries transient
 *  failures so one reset socket mid-crawl doesn't abort the run (CTL pattern). */
export const defaultFetch: Fetcher = async (url) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "WCM-Scholars-ETL/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return null;
      if (res.ok) return await res.text();
    } catch {
      // transient: DNS, reset socket, timeout — fall through to backoff
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  return null;
};

export function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop C0/C7F control bytes — a stray NUL must never reach the DB or a profile. */
export function stripControl(s: string): string {
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export type ArticleStub = {
  url: string;
  title: string;
  excerpt: string | null;
  thumbnailUrl: string | null;
};

/** Parse the 5 `view-teaser` cards on one listing page. Exported for tests. */
export function listingRows(html: string): ArticleStub[] {
  // Each feed card is a `views-row-* … view-teaser` div; split on the opener and
  // keep the blocks. A card carries its own title link, excerpt, and thumbnail.
  const blocks = html.split(/<div class="views-row[^"]*view-teaser">/i).slice(1);
  const out: ArticleStub[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    // The article path may be single- OR double-quoted in this markup.
    const slug = block.match(/\/about-us\/news-updates\/[a-z0-9][a-z0-9-]*/i)?.[0];
    if (!slug) continue;
    const url = NEWS_ORIGIN + slug;
    if (seen.has(url)) continue;
    seen.add(url);
    const titleInner = block.match(/teaser-title"><a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "";
    const title = stripControl(stripTags(titleInner));
    if (!title) continue;
    const excerptInner = block.match(/teaser-text"[^>]*>\s*(?:<p>)?([\s\S]*?)(?:<\/p>)?\s*<\/div>/i)?.[1] ?? "";
    const excerpt = stripControl(stripTags(excerptInner)) || null;
    const thumb =
      block.match(/<img\b[^>]*class="news-thumb[^"]*"[^>]*src="([^"]+)"/i)?.[1] ??
      block.match(/src="([^"]*\/news_images\/[^"]+)"/i)?.[1] ??
      null;
    const thumbnailUrl = thumb && thumb.startsWith(NEWS_ORIGIN + "/") ? thumb : null;
    out.push({ url, title, excerpt, thumbnailUrl });
  }
  return out;
}

/** The article body pane (`pane-node-body`) up to the next pane. Exported for tests. */
export function bodyRegion(html: string): string {
  const start = html.search(/panel-pane[^"]*pane-node-body/i);
  if (start < 0) return "";
  // Start after the pane div's opening `>` so the class attribute text
  // ("pane-node-body …") doesn't leak into the body.
  const open = html.indexOf(">", start);
  const rest = html.slice(open >= 0 ? open + 1 : start);
  const next = rest.search(/panel-pane pane-/i);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/** Publication date as an ISO YYYY-MM-DD, or null. Exported for tests. */
export function parseDate(html: string): string | null {
  // The date sits inside the `pane-node-created post-date` pane.
  const pane = html.match(/pane-node-created[\s\S]{0,600}?<\/div>/i)?.[0] ?? "";
  const m = pane.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/i,
  );
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month === undefined || day < 1 || day > 31) return null;
  // UTC midnight — deterministic, timezone-independent.
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

/** VIVO-linked cwids in the article body (lowercased, deduped). Exported for tests. */
export function parseCwids(html: string): string[] {
  const region = bodyRegion(html) || html;
  const out = new Set<string>();
  for (const m of region.matchAll(/cwid-([A-Za-z0-9]+)/gi)) out.add(m[1].toLowerCase());
  return [...out];
}

/** Parse one detail page into (publishedAt, cwids, bodyText). Exported for tests. */
export function parseDetail(html: string): {
  publishedAt: string | null;
  cwids: string[];
  bodyText: string;
} {
  const region = bodyRegion(html) || html;
  return {
    publishedAt: parseDate(html),
    cwids: parseCwids(html),
    bodyText: stripControl(stripTags(region)).slice(0, 60000),
  };
}

/**
 * Crawl the listing newest-first and return NEW article stubs (url not in
 * `knownUrls`). Stops once a page contributes nothing new to the DB — older
 * pages are all already ingested. A backfill passes an empty `knownUrls` (and a
 * larger `maxPages`) to walk the whole feed.
 */
export async function crawlNewStubs(
  get: Fetcher,
  knownUrls: Set<string>,
  maxPages = MAX_LISTING_PAGES_DEFAULT,
): Promise<ArticleStub[]> {
  const stubs: ArticleStub[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const html = await get(`${LISTING}?page=${page}`);
    if (html === null) break;
    const rows = listingRows(html);
    if (rows.length === 0) break; // past the end
    const freshToCrawl = rows.filter((r) => !seen.has(r.url));
    if (freshToCrawl.length === 0) break; // Drupal repeats the last page past the end
    for (const r of freshToCrawl) {
      seen.add(r.url);
      if (!knownUrls.has(r.url)) stubs.push(r);
    }
    // Incremental early-exit: a populated table + a page whose every article is
    // already ingested means all older pages are too.
    if (knownUrls.size > 0 && freshToCrawl.every((r) => knownUrls.has(r.url))) break;
  }
  return stubs;
}

/**
 * Full scrape: crawl new stubs, fetch each detail page, and return the scraped
 * articles. `nameIndex` is unused here (the importer runs name detection so it
 * can exclude VIVO-linked cwids and reconcile against existing rows) — it stays
 * out of the scraper.
 */
export async function scrapeNews(
  knownUrls: Set<string>,
  opts: { get?: Fetcher; maxPages?: number } = {},
): Promise<{ articles: ScrapedArticle[]; stubs: number; fetchFailed: number }> {
  const get = opts.get ?? defaultFetch;
  const stubs = await crawlNewStubs(get, knownUrls, opts.maxPages);
  const articles: ScrapedArticle[] = [];
  let fetchFailed = 0;
  for (const stub of stubs) {
    const html = await get(stub.url);
    if (html === null) {
      fetchFailed++;
      continue;
    }
    const { publishedAt, cwids, bodyText } = parseDetail(html);
    articles.push({ ...stub, publishedAt, cwids, bodyText });
  }
  return { articles, stubs: stubs.length, fetchFailed };
}

// `detectMentions` / `NameIndexEntry` are re-exported so index.ts and tests can
// pull the whole ETL surface from one module boundary if convenient.
export { detectMentions };
export type { NameIndexEntry };
