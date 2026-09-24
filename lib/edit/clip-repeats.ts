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

// ---------------------------------------------------------------------------
// Story grouping: every copy is kept; a later copy points at its story's lead
// (`news_mention.duplicate_of`). Auto-grouping is deliberately narrow; anything
// looser stays a queue suggestion (`findPossibleRepeat`) for a human.

/** Copies of one story arrive within this many days of each other. */
export const GROUP_WINDOW_DAYS = 14;
/** A headline needs this many content words before it can auto-group, so a
 *  recurring column name ("At A Glance") never merges two different stories. */
export const GROUP_MIN_WORDS = 4;

export type GroupableClip = ClipLike & {
  id: string;
  outlet: string | null;
  duplicateOf: string | null;
  creditedOutlet: string | null;
  createdAt?: Date | string;
};

const sameOutlet = (a: string | null, b: string | null) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * `duplicate_of` for each of the `fresh` rows (just imported, ungrouped) that is
 * another copy of a story: same scholar, same headline (`headlineKey`), at least
 * `GROUP_MIN_WORDS` content words, a DIFFERENT outlet, within
 * `GROUP_WINDOW_DAYS` of a row in `fresh` or `existing`. A copy joins the
 * story's existing lead. When a story is formed only of fresh rows, the copy
 * from the outlet the digest credits as the original publisher leads, else the
 * earliest. Existing rows are never regrouped, so a reviewer's Ungroup or Make
 * lead stands. Returns only the rows whose `duplicate_of` should change.
 */
export function assignGroups(
  fresh: readonly GroupableClip[],
  existing: readonly GroupableClip[],
): Map<string, string | null> {
  const time = (c: GroupableClip) => new Date(c.publishedAt ?? c.createdAt ?? 0).getTime();
  const pool: GroupableClip[] = existing.map((c) => ({ ...c }));
  const freshIds = new Set(fresh.map((c) => c.id));
  const byId = new Map(pool.map((c) => [c.id, c]));
  const leadOf = (c: GroupableClip) => (c.duplicateOf && byId.has(c.duplicateOf) ? c.duplicateOf : c.id);

  for (const r of [...fresh].sort((a, b) => time(a) - time(b))) {
    const row: GroupableClip = { ...r, duplicateOf: null };
    if (contentWords(r.title).size >= GROUP_MIN_WORDS) {
      const key = headlineKey(r.title);
      const match = pool.find((p) => {
        if (p.cwid !== r.cwid || headlineKey(p.title) !== key || sameOutlet(p.outlet, r.outlet)) return false;
        const d = daysApart(p.publishedAt, r.publishedAt);
        return d !== null && d <= GROUP_WINDOW_DAYS;
      });
      if (match) row.duplicateOf = leadOf(match);
    }
    pool.push(row);
    byId.set(row.id, row);
  }

  // A story made only of fresh rows: prefer the credited original as lead.
  const members = new Map<string, GroupableClip[]>();
  for (const c of pool) {
    if (!freshIds.has(c.id)) continue;
    const lead = leadOf(c);
    members.set(lead, [...(members.get(lead) ?? []), c]);
  }
  for (const [lead, group] of members) {
    if (group.length < 2 || !freshIds.has(lead) || group.some((c) => !freshIds.has(c.id))) continue;
    const credited = group.map((c) => c.creditedOutlet).filter((x): x is string => !!x);
    const original = group.find((c) => credited.some((x) => sameOutlet(x, c.outlet)));
    if (!original || original.id === lead) continue;
    for (const c of group) c.duplicateOf = c.id === original.id ? null : original.id;
  }

  const out = new Map<string, string | null>();
  for (const c of pool) if (freshIds.has(c.id) && c.duplicateOf !== null) out.set(c.id, c.duplicateOf);
  return out;
}

/** A placement shown in the profile's "Also in …" line. */
export type AlsoInLink = { outlet: string; url: string | null };

/** Links that are not a public article page (a saved broadcast clip). */
const NOT_PUBLIC_PAGE = /^https?:\/\/(?:www\.)?muckrack\.com\/broadcast\//i;
/** Outlet names shown before "and N more". */
export const ALSO_IN_CAP = 3;

/** The "Also in …" entries for a story's visible placements, first seen
 *  first: one per outlet, the lead's own outlet excluded, a saved broadcast
 *  clip unlinked. `more` counts the outlets past `ALSO_IN_CAP`. */
export function alsoIn(
  leadOutlet: string | null,
  placements: readonly { outlet: string | null; url: string }[],
): { shown: AlsoInLink[]; more: number } {
  const seen = new Set([(leadOutlet ?? "").trim().toLowerCase()]);
  const all: AlsoInLink[] = [];
  for (const p of placements) {
    const name = (p.outlet ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    all.push({ outlet: name, url: NOT_PUBLIC_PAGE.test(p.url) ? null : p.url });
  }
  return { shown: all.slice(0, ALSO_IN_CAP), more: Math.max(0, all.length - ALSO_IN_CAP) };
}
