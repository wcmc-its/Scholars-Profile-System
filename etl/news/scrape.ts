/**
 * Read the WCM Newsroom feed (news.weill.cornell.edu/news/feed.json).
 *
 * Attribution to a scholar comes first from the VIVO link an article prints
 * beside a faculty name (`vivo.weill.cornell.edu/display/cwid-<cwid>`), joined by
 * identifier — never by name. Articles that name a scholar in prose WITHOUT a
 * VIVO link are handled downstream by the name-dictionary matcher (names.ts),
 * which proposes a PENDING candidate for a human to confirm.
 *
 * #2200 — this used to crawl research.weill.cornell.edu/about-us/news-updates,
 * which is a SYNDICATION TARGET of the newsroom, not a source: every article
 * there carries a `news.weill.cornell.edu` canonical link, and the two publish
 * identical VIVO cwid sets. The newsroom is the upstream superset (~4.9k articles
 * back to 1997 vs ~1.2k back to 2019), and it exposes `feed.json` — one paginated
 * JSON endpoint carrying title, post date, canonical path, teaser, featured
 * image, and the FULL body HTML. That retires ~250 listing-page fetches plus one
 * detail fetch per article (~1,500 requests for a backfill) in favour of ~50 JSON
 * reads, and deletes the Drupal-markup regexes this file used to need.
 *
 * The RSS sibling (`/news/feed`) is NOT usable: it is capped at 15 items and
 * ignores `?page=` / `?items_per_page=` entirely.
 *
 * One page = 100 stories, newest first. The weekly run stops after the first
 * page that contributes nothing new; a backfill walks to the end.
 */
import {
  CWID_RE,
  NEWS_ORIGIN,
  NEWS_PATH_PREFIX,
  validateArticles,
  type ScrapedArticle,
} from "./seed";
import { detectMentions, type NameIndexEntry } from "./names";

const FEED = `${NEWS_ORIGIN}/news/feed.json`;

/** Hard ceiling on feed pages, so a pager bug can't spin forever. */
const MAX_FEED_PAGES_DEFAULT = 60; // > the ~50 live pages, with margin

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Mirror the seed validator's caps, so a long upstream field is truncated here
// rather than failing the whole run at validation.
const TITLE_MAX = 512;
const EXCERPT_MAX = 2000;
const BODY_MAX = 60000;

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
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop C0/C7F control bytes — a stray NUL must never reach the DB or a profile. */
export function stripControl(s: string): string {
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

const clean = (s: string): string => stripControl(stripTags(s));

/**
 * VIVO-linked cwids in the article body HTML (lowercased, deduped). Exported for
 * tests. Malformed ids are DROPPED, not emitted: the live path validates now, so
 * a single typo'd `cwid-` link upstream would otherwise fail the whole run.
 */
export function parseCwids(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/cwid-([A-Za-z0-9]+)/gi)) {
    const cwid = m[1].toLowerCase();
    if (CWID_RE.test(cwid)) out.add(cwid);
  }
  return [...out];
}

/** `field_story_post_date` ("August 5, 2026") as ISO YYYY-MM-DD, or null. Exported for tests. */
export function parseDate(text: string): string | null {
  const m = text.match(
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

/** The `{src, alt}` featured image, when it is a same-origin absolute URL. */
function thumbnailOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const src = (raw as { src?: unknown }).src;
  if (typeof src !== "string") return null;
  // The JSON HTML-escapes the cache-buster query string (`&amp;`).
  const url = stripTags(src);
  return url.startsWith(NEWS_ORIGIN + "/") ? url : null;
}

/**
 * Parse one `feed.json` page into articles. A story whose `path` is not a
 * same-origin news URL, or which has no title, is dropped rather than throwing —
 * the archive reaches back to 1997 and carries a few odd nodes; one bad row must
 * not sink a backfill. Exported for tests.
 */
export function feedStories(json: string): ScrapedArticle[] {
  const parsed: unknown = JSON.parse(json);
  const list = (parsed as { news_stories?: unknown }).news_stories;
  if (!Array.isArray(list)) throw new Error("[News] feed.json: missing news_stories array");

  const out: ScrapedArticle[] = [];
  for (const entry of list) {
    const story = (entry as { story?: unknown })?.story;
    if (typeof story !== "object" || story === null) continue;
    const s = story as Record<string, unknown>;

    const path = typeof s.path === "string" ? s.path : "";
    if (!path.startsWith(NEWS_ORIGIN + NEWS_PATH_PREFIX)) continue;

    const title = clean(typeof s.title === "string" ? s.title : "").slice(0, TITLE_MAX);
    if (!title) continue;

    const bodyHtml = typeof s.field_story_body === "string" ? s.field_story_body : "";
    const teaser = typeof s.field_story_teaser === "string" ? s.field_story_teaser : "";

    out.push({
      url: path,
      title,
      excerpt: clean(teaser).slice(0, EXCERPT_MAX) || null,
      thumbnailUrl: thumbnailOf(s.field_story_featured_image),
      publishedAt: parseDate(
        typeof s.field_story_post_date === "string" ? s.field_story_post_date : "",
      ),
      // cwids come from the raw HTML (the link href); bodyText is the prose the
      // name matcher scans.
      cwids: parseCwids(bodyHtml),
      bodyText: clean(bodyHtml).slice(0, BODY_MAX),
    });
  }
  return out;
}

/**
 * Walk the feed newest-first and return NEW articles (url not in `knownUrls`).
 * Stops after the first page that contributes nothing new — older pages are all
 * already ingested. A backfill passes an empty `knownUrls` to walk the whole feed.
 *
 * Throws if a page cannot be read. A feed page dropped mid-walk means articles
 * missing with no way to know which, so there is no partial-credit path here —
 * unlike the old per-article detail fetches, where skipping one was safe.
 */
export async function scrapeNews(
  knownUrls: Set<string>,
  opts: { get?: Fetcher; maxPages?: number } = {},
): Promise<ScrapedArticle[]> {
  const get = opts.get ?? defaultFetch;
  const maxPages = opts.maxPages ?? MAX_FEED_PAGES_DEFAULT;
  const articles: ScrapedArticle[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    const json = await get(`${FEED}?page=${page}`);
    if (json === null) {
      if (page === 0) throw new Error(`[News] feed unavailable: ${FEED}`);
      throw new Error(`[News] feed page ${page} unavailable — refusing a truncated crawl`);
    }
    const stories = feedStories(json);
    if (stories.length === 0) {
      // Past the end. Page 0 empty is a feed collapse, not an empty corpus.
      if (page === 0) throw new Error("[News] feed returned 0 stories — upstream changed?");
      break;
    }
    const fresh = stories.filter((a) => !seen.has(a.url));
    if (fresh.length === 0) break; // the pager repeated a page
    let added = 0;
    for (const a of fresh) {
      seen.add(a.url);
      if (!knownUrls.has(a.url)) {
        articles.push(a);
        added++;
      }
    }
    // Incremental early-exit: a populated table + a page whose every article is
    // already ingested means all older pages are too.
    // ponytail: an article that yields no mention rows never enters news_mention,
    // so it is never "known" and keeps this page from exiting. At 100 stories a
    // page that costs one extra JSON read, not 100 detail fetches — left as is.
    if (knownUrls.size > 0 && added === 0) break;
  }

  // These urls and image srcs become hrefs and <img src> on public profiles. The
  // seed path has always validated; the live path did not until #2200.
  return validateArticles(articles);
}

// `detectMentions` / `NameIndexEntry` are re-exported so index.ts and tests can
// pull the whole ETL surface from one module boundary if convenient.
export { detectMentions };
export type { NameIndexEntry };
