/**
 * Repeat detection for Media highlights clips (etl/news/clips.ts). The same
 * story reaches the digest more than once: a second day's digest, a syndicated
 * copy, a broadcast re-airing. The exact (cwid, url) repeat is already a no-op
 * (`@@unique([cwid, url])` + the upsert), so this covers what reaches us under
 * a DIFFERENT url. `findPossibleRepeat` (review queue, advisory) flags a
 * headline sharing most of its words with another clip for the same scholar
 * within `FLAG_REPEAT_DAYS` — an identical syndicated headline included.
 * Nothing is dropped automatically (a silent drop hid copies and could merge
 * two different stories under a generic headline); the reviewer decides.
 *
 * Pure: no db. Imported by the ETL and by `lib/edit/news-queue.ts`.
 */

export const FLAG_REPEAT_DAYS = 7;
/** Jaccard over headline content words at or above which two clips are flagged. */
export const FLAG_SIMILARITY = 0.5;
/** …and at least this many shared content words, so two short headlines don't
 *  match on "cancer" + "patients". */
const FLAG_MIN_SHARED = 3;

const STOPWORDS = new Set(
  "a an and are as at be but by can for from has have how in into is it its new of on or that the their this to was what when where which who why will with you your".split(
    " ",
  ),
);

function words(title: string): string[] {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** The headline with case, punctuation, accents and word order removed. */
export function headlineKey(title: string): string {
  return words(title).sort().join(" ");
}

/** Headline content words: stopwords and 1–2 letter tokens dropped. */
function contentWords(title: string): Set<string> {
  return new Set(words(title).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

export function headlinesSimilar(a: string, b: string): boolean {
  const x = contentWords(a);
  const y = contentWords(b);
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  const union = x.size + y.size - shared;
  return shared >= FLAG_MIN_SHARED && union > 0 && shared / union >= FLAG_SIMILARITY;
}

/** Whole days between two dates; null when either is missing (never "close"). */
function daysApart(a: Date | string | null, b: Date | string | null): number | null {
  if (a === null || b === null) return null;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

export type ClipLike = { cwid: string; url: string; title: string; publishedAt: Date | string | null };

/** The first OTHER clip for the same scholar within `FLAG_REPEAT_DAYS` whose
 *  headline is similar (`headlinesSimilar`), else null. */
export function findPossibleRepeat<T extends ClipLike & { id: string }>(
  row: ClipLike & { id: string },
  others: readonly T[],
): T | null {
  return (
    others.find((o) => {
      if (o.id === row.id || o.cwid !== row.cwid) return false;
      const d = daysApart(o.publishedAt, row.publishedAt);
      return d !== null && d <= FLAG_REPEAT_DAYS && headlinesSimilar(o.title, row.title);
    }) ?? null
  );
}
