/**
 * Author-byline text helpers, in a module a CLIENT component may import.
 *
 * These lived in `lib/api/topics.ts` (#2581). That file imports `@/lib/db` at
 * module scope, so a `"use client"` component importing the helper from there
 * drags the mariadb driver into the browser bundle and breaks the Next build on
 * `fs`/`net`. `lib/api/topics.ts` now re-exports from here, so there is still one
 * implementation and every existing caller is unchanged.
 *
 * NOTHING here touches the database. Keep it that way — the core claim queue is
 * a client component and imports it directly.
 */

/**
 * `authors_string` marks WCM-affiliated authors with `((…))` (the PubMed-ish
 * convention the reciter ETL writes; profile rendering overlays hyperlinks onto
 * those substrings). It is MARKUP, not part of anyone's name, and 157,704 of the
 * 197,528 publications carrying a byline have it.
 *
 * Strip the doubled markers as a PAIR, never with a lazy `\(.*?\)` — that eats
 * "((Lehman C)" and loses the surname (the trap `lib/coi-gap/pipeline.ts`
 * records). Single-paren affiliation groups are left alone here; this is a
 * display strip, not a name parser.
 */
export function stripWcmMarkers(authors: string): string {
  return authors.replace(/\(\(|\)\)/g, "");
}

/** Comma-delimited author count, markers stripped first so `((A B))` counts once.
 *  The repo already assumes comma-delimited authors at `etl/reciter/index.ts`
 *  (countAuthors) and `lib/api/mentoring.ts` (localAuthors); if that stops
 *  holding, all three need a real tokenizer, not just this one. */
export function countAuthorTokens(authors: string): number {
  return stripWcmMarkers(authors)
    .split(/,\s*/)
    .map((t) => t.trim())
    .filter(Boolean).length;
}

/**
 * How many authors the truncated `authors_string` drops relative to the full
 * list. 0 when nothing is dropped or either side is missing.
 *
 * #2581 measured this on the live corpus: of the 193,662 publications carrying
 * both fields the truncated one is shorter on 76,232 (39.4%), losing 3.68
 * authors on average and 1,264 in the worst case — with nothing on screen saying
 * so. On core 14's own review queue it is 68.4% of rows, worst case 413.
 */
export function droppedAuthorCount(
  authorsString: string | null,
  fullAuthorsString: string | null,
): number {
  if (!authorsString || !fullAuthorsString) return 0;
  return Math.max(0, countAuthorTokens(fullAuthorsString) - countAuthorTokens(authorsString));
}

/**
 * The byline text for one publication: the TRUNCATED `authors_string`, markers
 * stripped, followed by `+ N more` naming the authors the truncation drops.
 *
 * The truncated list is still what we SHOW (it is the preview sized for a result
 * row; `full_authors_string` is an unbounded Text column and a 1,264-name byline
 * is not a row); the suffix only makes the loss visible.
 */
export function bylineWithDroppedCount(
  authorsString: string | null,
  fullAuthorsString: string | null,
): string {
  if (!authorsString) return "";
  const byline = stripWcmMarkers(authorsString).trim();
  if (!byline || !fullAuthorsString) return byline;
  const dropped = droppedAuthorCount(authorsString, fullAuthorsString);
  return dropped > 0 ? `${byline} + ${dropped} more` : byline;
}
