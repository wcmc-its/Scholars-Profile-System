/**
 * Seed parser + validator for the WCM news-mentions ETL.
 *
 * Split out of index.ts (mirroring `etl/technologies/seed.ts`) so validation can
 * be unit-tested without running the importer's `main()`. The seed is one record
 * per SCRAPED ARTICLE — not per (scholar, article) mention — because the
 * scholar join (VIVO cwid + prose name-match) happens in the importer against
 * the live Scholar table, not at scrape time.
 *
 * Every guard here covers a path that can put text or an href onto a public
 * profile, so it is applied to BOTH the checked-in seed and the live scrape.
 */

/** The WCM Newsroom origin. Pinned — every url must sit under it. */
export const NEWS_ORIGIN = "https://news.weill.cornell.edu";
/** Article pages live under this path (`/news/<yyyy>/<mm>/<slug>`). */
export const NEWS_PATH_PREFIX = "/news/";

/** One scraped news article: its listing metadata + what the detail page yields. */
export type ScrapedArticle = {
  /** Absolute article URL (dedup key), under NEWS_ORIGIN + NEWS_PATH_PREFIX. */
  url: string;
  title: string;
  /** Listing excerpt/summary as plain text; null when the listing omits it. */
  excerpt: string | null;
  /** Absolute thumbnail URL under NEWS_ORIGIN; null when the listing omits it. */
  thumbnailUrl: string | null;
  /** Publication date as an ISO-8601 date (YYYY-MM-DD); null when unparseable. */
  publishedAt: string | null;
  /** VIVO-linked cwids on the detail page (lowercased). The trusted join. */
  cwids: string[];
  /** The article body as plain text — scanned for prose name-mentions. */
  bodyText: string;
};

/** Shared with the scraper so a cwid it emits can never fail validation here. */
export const CWID_RE = /^[a-z0-9]{2,32}$/;

/**
 * A publication-identity key for one article: publication date + the title's
 * words, SORTED (#2241).
 *
 * The upstream feed publishes some stories twice under different slugs, and the
 * titles are word-order variants of each other rather than identical:
 *
 *   /april-awards-honors   "April: Awards & Honors"
 *   /awards-honors-april   "Awards & Honors: April"
 *
 * Same date, same excerpt, same body — but `(cwid, url)`, the table's dedup key,
 * sees two rows, so the story renders twice on a profile. Sorting the tokens
 * collapses the word-order variant; a plain normalized title would not. Two
 * genuinely distinct stories sharing a date AND a word multiset is not a real
 * headline shape.
 *
 * Returns null when the article has no date — with only one weak signal left,
 * callers must fall back to the url and keep both rows rather than risk merging
 * two unrelated stories.
 */
export function storyKey(title: string, publishedAt: Date | string | null): string | null {
  if (publishedAt === null) return null;
  const day =
    typeof publishedAt === "string" ? publishedAt.slice(0, 10) : publishedAt.toISOString().slice(0, 10);
  const tokens = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .sort();
  if (tokens.length === 0) return null;
  return `${day}|${tokens.join(" ")}`;
}
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// C0 + DEL + C1. A C1 (U+0080-U+009F) is a double-encoded cp1252 punctuation
// byte; it renders as a box glyph on a profile. Lockstep with stripControl in
// ./scrape.
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const TITLE_MAX = 512;
const EXCERPT_MAX = 2000;
const BODY_MAX = 60000;

/** Parse + validate the seed. Throws on anything malformed. */
export function parseSeed(text: string): ScrapedArticle[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error("[News] seed must be a JSON array");
  return validateArticles(raw);
}

/** Validate already-parsed article records. */
export function validateArticles(raw: unknown[]): ScrapedArticle[] {
  const seen = new Set<string>();
  return raw.map((r, i) => {
    if (typeof r !== "object" || r === null) throw new Error(`[News] article ${i}: not an object`);
    const { url, title, excerpt, thumbnailUrl, publishedAt, cwids, bodyText } = r as Record<
      string,
      unknown
    >;

    // The url becomes an href on a public profile. Pin it to the news path under
    // the WCM origin so a corrupt or tampered seed cannot inject an off-site or
    // `javascript:` link.
    if (typeof url !== "string" || !url.startsWith(NEWS_ORIGIN + NEWS_PATH_PREFIX)) {
      throw new Error(`[News] article ${i}: url must start with ${NEWS_ORIGIN}${NEWS_PATH_PREFIX}`);
    }
    if (typeof title !== "string" || title.trim() === "") {
      throw new Error(`[News] article ${i} (${url}): title is required`);
    }
    if (title.length > TITLE_MAX || CONTROL_RE.test(title)) {
      throw new Error(`[News] article ${i} (${url}): title too long or carries control chars`);
    }

    if (excerpt !== null && excerpt !== undefined) {
      if (typeof excerpt !== "string" || excerpt.length > EXCERPT_MAX || CONTROL_RE.test(excerpt)) {
        throw new Error(`[News] article ${i} (${url}): invalid excerpt`);
      }
    }

    // The thumbnail becomes an <img src> on a public profile — same origin pin.
    if (thumbnailUrl !== null && thumbnailUrl !== undefined) {
      if (typeof thumbnailUrl !== "string" || !thumbnailUrl.startsWith(NEWS_ORIGIN + "/")) {
        throw new Error(`[News] article ${i} (${url}): thumbnailUrl must start with ${NEWS_ORIGIN}/`);
      }
    }

    if (publishedAt !== null && publishedAt !== undefined) {
      if (typeof publishedAt !== "string" || !ISO_DATE_RE.test(publishedAt)) {
        throw new Error(`[News] article ${i} (${url}): publishedAt must be YYYY-MM-DD or null`);
      }
    }

    if (cwids !== undefined && !Array.isArray(cwids)) {
      throw new Error(`[News] article ${i} (${url}): cwids must be an array`);
    }
    const cwidList = (cwids ?? []) as unknown[];
    for (const c of cwidList) {
      if (typeof c !== "string" || !CWID_RE.test(c)) {
        throw new Error(`[News] article ${i} (${url}): invalid cwid ${JSON.stringify(c)}`);
      }
    }

    if (typeof bodyText !== "string" || bodyText.length > BODY_MAX || CONTROL_RE.test(bodyText)) {
      throw new Error(`[News] article ${i} (${url}): bodyText missing, too long, or has control chars`);
    }

    if (seen.has(url)) throw new Error(`[News] article ${i}: duplicate url ${url}`);
    seen.add(url);

    return {
      url,
      title: title.trim(),
      excerpt: (excerpt as string | null | undefined) ?? null,
      thumbnailUrl: (thumbnailUrl as string | null | undefined) ?? null,
      publishedAt: (publishedAt as string | null | undefined) ?? null,
      cwids: [...new Set(cwidList as string[])],
      bodyText,
    };
  });
}
