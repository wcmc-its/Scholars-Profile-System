/**
 * #1511 — change detection for the reciter ETL, so a nightly run only writes
 * rows whose content actually changed. Two independent concerns:
 *
 *  A. `publication` upsert churn — the corpus was blind-upserted every night
 *     (100k+ full-row rewrites incl. 15KB abstracts). `publicationSignature`
 *     lets the loop skip rows whose reciter-owned fields are byte-identical.
 *
 *  B. `publicationAuthor` watermark — the corpus was wiped and reinserted every
 *     night, re-stamping `lastRefreshedAt` (@default(now())) on EVERY row, which
 *     defeats etl/coi-gap's incremental watermark (it selects
 *     `publicationAuthor.lastRefreshedAt > watermark`, so every run became a
 *     full-cohort recompute). `planAuthorshipReconcile` keys on (pmid, cwid) and
 *     LEAVES unchanged rows untouched so their timestamp is preserved.
 *
 * Both comparisons are deliberately CONSERVATIVE: they err toward "changed"
 * (a needless rewrite is harmless; silently skipping a genuine change is not).
 * Normalizers only collapse values the column could not store differently
 * (date-only, Decimal string form), never a real content difference; encodings
 * are JSON so `null` never collides with a string like "" or " ".
 *
 * Pure (no Prisma client / I/O) so it is unit-testable without a ReciterDB read
 * — the same split as the mapper modules.
 */
import { Prisma } from "@/lib/generated/prisma/client";

// ---------------------------------------------------------------------------
// Part A — publication content signature
// ---------------------------------------------------------------------------

/**
 * The fields etl/reciter writes on a publication upsert — everything except the
 * `pmid` key and `lastRefreshedAt` (which this ETL controls). `synopsis`,
 * `impact*`, and `topTopicId` are owned by OTHER ETLs and deliberately excluded.
 */
export type PublicationComparable = {
  title: string;
  authorsString: string | null;
  fullAuthorsString: string | null;
  journal: string | null;
  year: number | null;
  publicationType: string | null;
  citationCount: number;
  relativeCitationRatio: Prisma.Decimal | number | null;
  nihPercentile: Prisma.Decimal | number | null;
  citedByCount: number | null;
  dateAddedToEntrez: Date | null;
  doi: string | null;
  pmcid: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  journalAbbrev: string | null;
  pubmedUrl: string | null;
  ecommonsLink: string | null;
  abstract: string | null;
  meshTerms: unknown; // JSON value, Prisma.DbNull/JsonNull, or null
  source: string;
};

// Faithful, no-rounding Decimal string form (Prisma.Decimal or plain number),
// so equal stored values match and any real difference shows.
const dec = (v: Prisma.Decimal | number | null | undefined): string | null =>
  v == null ? null : v.toString();
// @db.Date stores date-only, so compare the date portion — a time component the
// column cannot store must not read as a change.
const dateOnly = (v: Date | null | undefined): string | null =>
  v == null ? null : v.toISOString().slice(0, 10);
// JSON column: DbNull / JsonNull / null all mean "no value"; otherwise the value
// itself (element order IS part of the stored value and is preserved).
const jsonNorm = (v: unknown): unknown =>
  v == null || v === Prisma.DbNull || v === Prisma.JsonNull ? null : v;

/**
 * Canonical signature over the reciter-written publication fields. Two rows with
 * equal signatures are identical as this ETL would store them, so the upsert can
 * be skipped (and `lastRefreshedAt` left alone). JSON.stringify of the tuple
 * distinguishes null from every string/number, so no sentinel can collide.
 */
export function publicationSignature(row: PublicationComparable): string {
  return JSON.stringify([
    row.title,
    row.authorsString ?? null,
    row.fullAuthorsString ?? null,
    row.journal ?? null,
    row.year ?? null,
    row.publicationType ?? null,
    row.citationCount,
    dec(row.relativeCitationRatio),
    dec(row.nihPercentile),
    row.citedByCount ?? null,
    dateOnly(row.dateAddedToEntrez),
    row.doi ?? null,
    row.pmcid ?? null,
    row.volume ?? null,
    row.issue ?? null,
    row.pages ?? null,
    row.journalAbbrev ?? null,
    row.pubmedUrl ?? null,
    row.ecommonsLink ?? null,
    row.abstract ?? null,
    jsonNorm(row.meshTerms),
    row.source,
  ]);
}

// ---------------------------------------------------------------------------
// Part B — authorship reconcile
// ---------------------------------------------------------------------------

export type AuthorshipComparable = {
  position: number;
  totalAuthors: number;
  isFirst: boolean;
  isLast: boolean;
  isPenultimate: boolean;
  isConfirmed: boolean;
};

export function authorshipSignature(row: AuthorshipComparable): string {
  return JSON.stringify([
    row.position,
    row.totalAuthors,
    row.isFirst,
    row.isLast,
    row.isPenultimate,
    row.isConfirmed,
  ]);
}

/** Existing DB row: cwid may be NULL (a non-WCM author row). */
export type ExistingAuthorship = AuthorshipComparable & {
  id: string;
  pmid: string;
  cwid: string | null;
};
/** Freshly computed WCM authorship: cwid is always present. */
export type IncomingAuthorship = AuthorshipComparable & {
  pmid: string;
  cwid: string;
};

// JSON-encoded (pmid, cwid) key. An existing row with cwid=NULL encodes as
// [pmid, null] — which no incoming row (cwid always a string) can match — so it
// is pruned, reproducing the old wipe's net effect of leaving only the
// freshly-computed WCM rows for these pmids.
const keyOf = (pmid: string, cwid: string | null): string =>
  JSON.stringify([pmid, cwid]);

export type AuthorshipReconcilePlan = {
  toCreate: IncomingAuthorship[];
  toUpdate: { id: string; row: IncomingAuthorship }[];
  toDeleteIds: string[];
  unchanged: number;
};

/**
 * Reconcile existing publicationAuthor rows (for a set of pmids) against the
 * freshly computed WCM set, keyed on (pmid, cwid): create new keys, update
 * changed keys by id (+bump lastRefreshedAt at the call site), delete keys no
 * longer present, and LEAVE unchanged keys untouched so their `lastRefreshedAt`
 * is preserved (the coi-gap watermark fix). Duplicate existing keys — there is
 * no DB unique on (pmid, cwid) — keep the first as canonical and mark the rest
 * for deletion, cleaning up a historical duplicate rather than double-counting.
 */
export function planAuthorshipReconcile(
  existing: readonly ExistingAuthorship[],
  incoming: readonly IncomingAuthorship[],
): AuthorshipReconcilePlan {
  const existingByKey = new Map<string, ExistingAuthorship>();
  const toDeleteIds: string[] = [];
  for (const e of existing) {
    const k = keyOf(e.pmid, e.cwid);
    if (existingByKey.has(k)) {
      toDeleteIds.push(e.id); // duplicate (or a cwid=NULL row) — prune it
    } else {
      existingByKey.set(k, e);
    }
  }

  const toCreate: IncomingAuthorship[] = [];
  const toUpdate: { id: string; row: IncomingAuthorship }[] = [];
  let unchanged = 0;
  const seen = new Set<string>();
  for (const inc of incoming) {
    const k = keyOf(inc.pmid, inc.cwid);
    seen.add(k);
    const ex = existingByKey.get(k);
    if (!ex) {
      toCreate.push(inc);
    } else if (authorshipSignature(ex) !== authorshipSignature(inc)) {
      toUpdate.push({ id: ex.id, row: inc });
    } else {
      unchanged += 1;
    }
  }
  for (const [k, ex] of existingByKey) {
    if (!seen.has(k)) toDeleteIds.push(ex.id);
  }
  return { toCreate, toUpdate, toDeleteIds, unchanged };
}
