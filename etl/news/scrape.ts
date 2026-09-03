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
const TAG_MAX = 255;
const CAPTION_MAX = 4000;

/**
 * Ignore articles published before this date.
 *
 * The newsroom archive reaches 1997, but it is pre-VIVO: sampled pages covering
 * 2014/2002/2001/1999 carry ZERO `cwid-` links across 327 articles, so the whole
 * archive can only ever produce prose NAME candidates — thousands of PENDING
 * rows into a review queue that currently has none of its 484 worked. The old
 * research-site corpus started in 2019, so this floor holds ingestion at parity
 * rather than dumping 3.7k unreviewable candidates on curators.
 *
 * It also gives the walk a real termination condition: the feed is newest-first,
 * so a page entirely below the floor means every older page is too. Without it
 * the incremental exit can never fire, because an article that yields no mention
 * row never enters news_mention and so is never "known".
 *
 * Override with NEWS_MIN_PUBLISHED=YYYY-MM-DD (empty string disables the floor).
 */
const MIN_PUBLISHED_DEFAULT = "2019-01-01";

function minPublished(): string {
  const raw = process.env.NEWS_MIN_PUBLISHED;
  if (raw === undefined) return MIN_PUBLISHED_DEFAULT;
  if (raw === "") return ""; // explicit opt-out: walk the whole archive
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`[News] NEWS_MIN_PUBLISHED must be YYYY-MM-DD, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

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

/**
 * Drop C0/DEL/C1 control bytes — a stray NUL must never reach the DB or a
 * profile, and a C1 (U+0080-U+009F) is what a cp1252 smart quote decodes to when
 * the upstream double-encodes: it renders as a box glyph mid-word rather than
 * failing loudly. Must stay in lockstep with CONTROL_RE in ./seed.
 */
export function stripControl(s: string): string {
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

const clean = (s: string): string => stripControl(stripTags(s));

/**
 * Cap at `max`, cutting on a word boundary and marking the elision. The
 * newsroom teaser is a full lede, not a listing blurb, and it renders verbatim
 * on a public profile — a hard slice lands mid-word.
 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

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

/**
 * `term_node_tid` — the feed's own comma-delimited story tags — as a trimmed,
 * deduped list (#2578). Exported for tests.
 *
 * The list mixes faculty names, departments, centers, topic tags and the story
 * type: "Dr. Scott Tagawa, Englander Institute for Precision Medicine,
 * Hematology and Oncology, …, News from WCM". It is NOT classified here.
 * Person tags are not reliably `Dr. `-prefixed (students are tagged bare), so
 * any up-front person-vs-department split would be guesswork; names.ts instead
 * intersects every entry against the scholar roster, and an entry that resolves
 * to nobody simply matches nothing.
 *
 * Entity-decoded through the same `clean()` as every other field — the feed
 * publishes "Awards &amp; Honors" — and each entry capped at TAG_MAX so one long
 * upstream term truncates instead of failing the whole run at validation.
 */
export function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const tag = truncate(clean(part), TAG_MAX);
    if (tag) out.add(tag);
  }
  return [...out];
}

/**
 * Every photo's alt text on the page — the featured image plus each body
 * `<img alt>` — space-joined (#2578). Exported for tests.
 *
 * This is where a caption names its subject on this feed. There is no
 * `<figcaption>` anywhere in the corpus (0/100 sampled); a captioned photo is a
 * triple-nested `<div class="caption">` wrapper whose person name lives in the
 * img's alt attribute — `alt="Dr. Olivier Elemento"`, `alt="Dr. Kyu Rhee"`. So
 * one attribute regex gets the whole signal and no HTML parser is needed.
 *
 * `clean()` strips attributes, so none of this text reaches bodyText: a scholar
 * named ONLY in a photo alt is invisible to the prose pass. Measured on 100 live
 * stories, 12 carried a person-shaped alt name absent from the prose.
 *
 * ponytail: alt attributes only, NOT the caption's visible prose. That prose is
 * a text node three `<div>`s deep inside the `.caption` wrapper, so reaching it
 * means a real HTML parse for what is already the weakest tier — and its subject
 * is normally the alt text anyway. Upgrade path if a reviewer ever reports a
 * miss: match the `<div class="caption">…</div>` block and strip it, rather than
 * adding a parser dependency for one field.
 */
export function parseCaptions(bodyHtml: string, featuredImage: unknown): string {
  const alts: string[] = [];
  const featuredAlt =
    typeof featuredImage === "object" && featuredImage !== null
      ? (featuredImage as { alt?: unknown }).alt
      : undefined;
  if (typeof featuredAlt === "string") alts.push(featuredAlt);
  for (const m of bodyHtml.matchAll(/<img\b[^>]*\balt="([^"]*)"/gi)) alts.push(m[1]);
  const joined = alts
    .map((a) => clean(a))
    .filter((a) => a.length > 0)
    .join(" ");
  return truncate(joined, CAPTION_MAX);
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

  // `field_story_body` is the ONLY carrier of the VIVO cwid links — the whole
  // trusted join. If upstream renames it or re-types it (Drupal's formatted-text
  // shape is {value, format}, not a bare string), every story would silently
  // yield zero cwids and the run would record a hollow success. Measured 100%
  // non-empty across all 50 live pages, so a half-empty page is a shape change,
  // not thin content. Fail loudly instead.
  const withBody = list.filter(
    (e) => typeof (e as { story?: { field_story_body?: unknown } })?.story?.field_story_body ===
      "string" &&
      ((e as { story: { field_story_body: string } }).story.field_story_body.length > 0),
  ).length;
  if (list.length >= 20 && withBody / list.length < 0.5) {
    throw new Error(
      `[News] feed.json: only ${withBody}/${list.length} stories carry a non-empty ` +
        `field_story_body — upstream shape changed; the VIVO join would silently empty`,
    );
  }

  const out: ScrapedArticle[] = [];
  for (const entry of list) {
    const story = (entry as { story?: unknown })?.story;
    if (typeof story !== "object" || story === null) continue;
    const s = story as Record<string, unknown>;

    const path = typeof s.path === "string" ? s.path : "";
    if (!path.startsWith(NEWS_ORIGIN + NEWS_PATH_PREFIX)) continue;

    const title = truncate(clean(typeof s.title === "string" ? s.title : ""), TITLE_MAX);
    if (!title) continue;

    const bodyHtml = typeof s.field_story_body === "string" ? s.field_story_body : "";
    const teaser = typeof s.field_story_teaser === "string" ? s.field_story_teaser : "";

    out.push({
      url: path,
      title,
      excerpt: truncate(clean(teaser), EXCERPT_MAX) || null,
      thumbnailUrl: thumbnailOf(s.field_story_featured_image),
      publishedAt: parseDate(
        typeof s.field_story_post_date === "string" ? s.field_story_post_date : "",
      ),
      // cwids come from the raw HTML (the link href); bodyText is the prose the
      // name matcher scans.
      cwids: parseCwids(bodyHtml),
      bodyText: clean(bodyHtml).slice(0, BODY_MAX),
      // #2578 — the feed's own faculty tags (the strongest mention signal) and
      // the photo alt text (the weakest). Both are read off the raw story, so
      // they must be parsed here rather than recovered from bodyText later.
      tags: parseTags(s.term_node_tid),
      captionText: parseCaptions(bodyHtml, s.field_story_featured_image),
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
  opts: { get?: Fetcher; maxPages?: number; minPublished?: string } = {},
): Promise<ScrapedArticle[]> {
  const get = opts.get ?? defaultFetch;
  const maxPages = opts.maxPages ?? MAX_FEED_PAGES_DEFAULT;
  const floor = opts.minPublished ?? minPublished();
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
    // Dedupe in ONE place: filtering and marking separately would let two
    // entries sharing a path on the SAME page both through, and validateArticles
    // rejects a duplicate url by failing the entire run.
    const fresh = stories.filter((a) => (seen.has(a.url) ? false : (seen.add(a.url), true)));
    if (fresh.length === 0) break; // the pager repeated a page

    // Newest-first: once a whole page sits below the floor, so does every older
    // page. This is the walk's real terminator — see MIN_PUBLISHED_DEFAULT.
    const inWindow = floor
      ? fresh.filter((a) => a.publishedAt === null || a.publishedAt >= floor)
      : fresh;
    if (floor && inWindow.length === 0) break;

    let added = 0;
    for (const a of inWindow) {
      if (!knownUrls.has(a.url)) {
        articles.push(a);
        added++;
      }
    }
    // Incremental early-exit: a populated table plus a page that contributed
    // nothing new means the older pages are already ingested too.
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
