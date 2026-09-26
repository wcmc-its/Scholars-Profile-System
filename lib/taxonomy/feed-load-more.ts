/**
 * TAXONOMY_FEED_LOAD_MORE — the pure rules behind the taxonomy feeds' Load more
 * (topic, method family and method category pages). Shared by the client feed
 * (`components/taxonomy/publication-feed.tsx`) and the publication routes'
 * `limit` validation, so the two can never disagree on what a valid size is.
 *
 * Client-safe: no db / server imports.
 */

/** Rows per Load more click, and the routes' default page size. */
export const FEED_CHUNK = 20;

/**
 * Largest `?shown=` restore, and the largest `limit` a publication route
 * accepts in one request. Bounds the one-shot restore query (and a crafted
 * `limit`) to ten chunks.
 */
export const FEED_SHOWN_MAX = 200;

/**
 * The `?shown=N` value to restore on load, or null to start at one chunk.
 * Digits only (no sign, no exponent, no fraction); N at or under one chunk is
 * the default; N is rounded UP to a whole chunk (a hand-edited 35 restores the
 * 40 rows that include the 35th) and clamped to FEED_SHOWN_MAX.
 */
export function readShownParam(search: string): number | null {
  const raw = new URLSearchParams(search).get("shown");
  if (raw === null || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  if (n <= FEED_CHUNK) return null;
  return Math.min(FEED_SHOWN_MAX, Math.ceil(n / FEED_CHUNK) * FEED_CHUNK);
}

/**
 * Write (or, for null / one chunk, remove) `?shown=` on the current history
 * entry with `history.replaceState`: no navigation, no scroll, no server round
 * trip, and Back to this entry restores the loaded rows. Every other param and
 * the fragment are kept. Best effort: a failure leaves the URL as it was.
 */
export function writeShownParam(n: number | null): void {
  try {
    const url = new URL(window.location.href);
    // Written values obey the same rule `readShownParam` restores by (whole
    // chunks, at most FEED_SHOWN_MAX), so the URL never shows e.g. ?shown=280.
    const clamped =
      n === null || !Number.isFinite(n) || n <= FEED_CHUNK
        ? null
        : Math.min(FEED_SHOWN_MAX, Math.ceil(n / FEED_CHUNK) * FEED_CHUNK);
    if (clamped === null) {
      if (!url.searchParams.has("shown")) return;
      url.searchParams.delete("shown");
    } else {
      if (url.searchParams.get("shown") === String(clamped)) return;
      url.searchParams.set("shown", String(clamped));
    }
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // URL sync is best effort; the rows on screen are already right.
  }
}

/** The next chunk's size: one chunk, or what is left; 0 hides the button. */
export function nextChunkSize(loaded: number, total: number): number {
  return Math.max(0, Math.min(FEED_CHUNK, total - loaded));
}

/** "Show 20 more · 40 of 279" (counts localized). */
export function loadMoreLabel(loaded: number, shown: number, total: number): string {
  return `Show ${nextChunkSize(loaded, total).toLocaleString()} more · ${shown.toLocaleString()} of ${total.toLocaleString()}`;
}

/**
 * Validate a publication route's optional `limit` param. Absent ⇒ the default
 * chunk. Present ⇒ digits only, a whole number of chunks, at most
 * FEED_SHOWN_MAX; anything else is invalid (the route answers 400).
 */
export function parseFeedLimit(raw: string | null): number | "invalid" {
  if (raw === null) return FEED_CHUNK;
  if (!/^\d{1,4}$/.test(raw)) return "invalid";
  const n = Number(raw);
  if (n < FEED_CHUNK || n > FEED_SHOWN_MAX || n % FEED_CHUNK !== 0) return "invalid";
  return n;
}

/**
 * The publication routes' historical depth cap: page 500 at 20 rows, i.e. at
 * most 9,980 rows skipped. `clampFeedPage` keeps that OFFSET bound for every
 * `limit`, so a 200-row page cannot reach 10x deeper than a 20-row one.
 */
export const FEED_MAX_PAGE = 500;
const FEED_MAX_OFFSET = (FEED_MAX_PAGE - 1) * FEED_CHUNK;

/**
 * 1-indexed URL page → the 0-indexed service page, clamped so that
 * page × pageSize never exceeds FEED_MAX_OFFSET. At the default 20-row size
 * this is exactly the old `min(page, 500) - 1`.
 */
export function clampFeedPage(pageNum: number, pageSize: number): number {
  return Math.min(pageNum - 1, Math.floor(FEED_MAX_OFFSET / pageSize));
}
