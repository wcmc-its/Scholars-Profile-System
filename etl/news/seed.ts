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

/** The WCM Research site origin. Pinned — every url must sit under it. */
export const NEWS_ORIGIN = "https://research.weill.cornell.edu";
/** Article detail pages live under this path. */
export const NEWS_PATH_PREFIX = "/about-us/news-updates/";

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

const CWID_RE = /^[a-z0-9]{2,32}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
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
