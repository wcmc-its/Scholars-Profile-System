/**
 * Research security ETL — the pure half: which of our people are attached to
 * each flagged article, and the rows the four `research_security_*` tables
 * get. No database import, so every rule here is unit-tested
 * (`tests/unit/research-security-etl.test.ts`).
 *
 * The source tables and their semantics are reciterdb's
 * (`setup/table_research_security_v3.13.sql`, `update/collectAffiliations.py`):
 * `watchlist_match` covers EVERY stored article, including ones whose
 * authorship was later rejected, so an article is kept only when one of our
 * people is attached to it today.
 */
import { assertSourceVolume } from "../../lib/etl-guard";

export type Attribution = "confirmed" | "pending" | "review_queue";
/** 'unknown' is an open review-queue row with no proposed person: nobody's
 *  person type is attached, so no campus is claimed for it. */
export type Campus = "wcm" | "ithaca" | "unknown";

/** External validation cohorts stored in the same reciterdb (Fred Hutch, the
 *  UC campuses, USC). The same pattern is applied in SQL (`EXTERNAL_COHORT_SQL`). */
export const EXTERNAL_COHORT_RE = /^(fh|fredhutch|uc[a-z]*|usc)_/i;
export const EXTERNAL_COHORT_SQL = "^(fh|fredhutch|uc[a-z]*|usc)_";

export function isExternalCohort(cwid: string | null | undefined): boolean {
  return !!cwid && EXTERNAL_COHORT_RE.test(cwid.trim());
}

/** Cornell (Ithaca) only when a person type is exactly `cornell-ithaca`.
 *  `affiliate-cornell` is a WCM type. */
export function campusOf(personTypes: Iterable<string | null | undefined>): "wcm" | "ithaca" {
  for (const t of personTypes) if (t === "cornell-ithaca") return "ithaca";
  return "wcm";
}

/**
 * The lower-cased cwids on the Ithaca campus, from `person_person_type` rows.
 * The exact-match rule is {@link campusOf}'s, applied HERE and not by the SQL
 * that fetched the rows: reciterdb compares `personType` case-insensitively
 * and ignoring trailing spaces (utf8mb4_unicode_ci), which is not "exactly".
 */
export function ithacaCwids(
  rows: Iterable<{ cwid: string | null; personType: string | null }>,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const cwid = r.cwid?.trim().toLowerCase();
    if (cwid && campusOf([r.personType]) === "ithaca") out.add(cwid);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Name keys: ONE definition of "this byline name is that person", reciterdb's
// ---------------------------------------------------------------------------

/** `[surname, given name]`, each letters only and lower-cased. */
export type NameKey = readonly [last: string, first: string];

function letters(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function nameTokens(name: string | null | undefined): string[] {
  return (name ?? "").split(/\s+/).map(letters).filter(Boolean);
}

/** reciterdb's `watchlist_patterns.name_key`: the FULL given name, letters
 *  only, so "Yi-Ming" = "Yi Ming" = "Yiming". Null without both parts. */
export function nameKey(first: string | null | undefined, last: string | null | undefined): NameKey | null {
  const key = [letters(last), letters(first)] as const;
  return key[0] && key[1] ? key : null;
}

/**
 * Every name key of each person, by lower-cased cwid, from `person`
 * (firstName, lastName) AND `identity` (givenName, surname) rows: the same two
 * sources reciterdb's `collectAffiliations` builds its keys from, so a person
 * whose publishing name differs from the HR legal name has both.
 */
export function nameKeysByCwid(
  rows: Iterable<{ cwid: string | null; first: string | null; last: string | null }>,
): Map<string, NameKey[]> {
  const out = new Map<string, NameKey[]>();
  for (const r of rows) {
    const cwid = r.cwid?.trim().toLowerCase();
    const key = nameKey(clean(r.first), clean(r.last));
    if (!cwid || !key) continue;
    const keys = out.get(cwid) ?? [];
    if (!keys.some((k) => k[0] === key[0] && k[1] === key[1])) keys.push(key);
    out.set(cwid, keys);
  }
  return out;
}

/**
 * A port of reciterdb's `collectAffiliations.is_our_author`, the rule that sets
 * `watchlist_match.is_institution_author`: the byline name must END with the
 * surname (so a multi-word surname works) and the given names before it must
 * equal the first name, as written or with trailing single-letter tokens
 * (middle initials) dropped. "Yi Ming Wang" is not "Yi Wang"; an initials-only
 * byline never matches.
 */
export function isOurAuthor(name: string | null | undefined, keys: Iterable<NameKey>): boolean {
  const toks = nameTokens(name);
  for (const [last, first] of keys) {
    for (let i = 1; i < toks.length; i++) {
      if (toks.slice(i).join("") !== last) continue;
      let given = toks.slice(0, i);
      if (given.join("") === first) return true;
      while (given.length && given[given.length - 1].length === 1) given = given.slice(0, -1);
      if (given.length && given.join("") === first) return true;
    }
  }
  return false;
}

/**
 * Which of the people attached to an article a matched byline name is, by
 * {@link isOurAuthor}. reciterdb's `is_institution_author` says only that the
 * name is SOME in-scope person's (confirmed, pending or review-queue, either
 * campus); the dashboard has to know whose, so that a pending namesake never
 * marks a confirmed author. Returned as the cwids were given.
 */
export function ourAuthorCwids(
  authorName: string | null | undefined,
  cwidsOnArticle: Iterable<string>,
  names: ReadonlyMap<string, readonly NameKey[]>,
): string[] {
  const out: string[] = [];
  for (const cwid of cwidsOnArticle) {
    if (isOurAuthor(authorName, names.get(cwid.toLowerCase()) ?? [])) out.push(cwid);
  }
  return out;
}

/** The column holds a comma-separated list; whole cwids only. */
export function joinCwids(cwids: readonly string[], max = 512): string | null {
  let out = "";
  for (const c of cwids) {
    const next = out ? `${out},${c}` : c;
    if (next.length > max) break;
    out = next;
  }
  return out || null;
}

/**
 * Whether a review-queue byline ("Jane Doe", "Doe J", "Doe, Jane") could be a
 * person with these keys: same surname and same first initial, surname first
 * or last. Deliberately looser than {@link isOurAuthor}: it only decides
 * whether a review row with no proposed person repeats someone already listed
 * on the paper.
 */
export function bylineCouldBe(byline: string | null | undefined, keys: Iterable<NameKey>): boolean {
  const toks = nameTokens(byline);
  for (const [last, first] of keys) {
    for (let i = 1; i < toks.length; i++) {
      if (toks.slice(i).join("") === last && toks[0][0] === first[0]) return true;
      if (toks.slice(0, i).join("") === last && toks[i][0] === first[0]) return true;
    }
  }
  return false;
}

/** 'confirmed' is decided by the table (`analysis_summary_author`); this is the
 *  `person_article` half: an empty or PENDING assertion is a suggestion nobody
 *  has reviewed. */
export function isPendingAssertion(userAssertion: string | null | undefined): boolean {
  const a = (userAssertion ?? "").trim().toUpperCase();
  return a === "" || a === "PENDING";
}

export function normDoi(doi: string | null | undefined): string | null {
  const d = (doi ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "");
  return d || null;
}

/** How reciterdb's utf8mb4_unicode_ci primary key sees an article id. */
export function ci(articleId: string): string {
  return articleId.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trimEnd();
}

/**
 * reciterdb's stable article key (`collectAffiliations.article_key`): the pmid
 * as a string for a PubMed article, else the stored `article_id`, else the id a
 * review row will have once accepted (`UPPER(source):external_id`), else
 * `DOI:<doi>`. NEVER the negative pmid, which is renumbered every night.
 */
export function articleKey(r: {
  pmid?: number | string | bigint | null;
  articleId?: string | null;
  doi?: string | null;
  source?: string | null;
  externalId?: string | null;
}): string | null {
  const p = r.pmid == null ? 0 : Number(r.pmid);
  if (Number.isInteger(p) && p > 0) return String(p);
  const aid = (r.articleId ?? "").trim();
  if (aid) return aid;
  const src = (r.source ?? "").trim().toUpperCase();
  const ext = (r.externalId ?? "").trim();
  if (ext && src && src !== "PUBMED") return `${src}:${ext}`;
  const d = normDoi(r.doi);
  return d ? `DOI:${d}` : null;
}

export function sourceOf(articleId: string): string {
  if (/^\d+$/.test(articleId)) return "pubmed";
  const prefix = articleId.split(":")[0].toLowerCase();
  return ["scopus", "openalex", "crossref"].includes(prefix) ? prefix : "other";
}

// ---------------------------------------------------------------------------
// Source rows
// ---------------------------------------------------------------------------

export type AcceptedRow = {
  cwid: string | null;
  pmid: number | null;
  articleId: string | null;
  doi: string | null;
};
export type PendingRow = {
  cwid: string | null;
  pmid: number | null;
  doi: string | null;
  userAssertion: string | null;
  score: number | null;
};
export type ReviewRow = {
  cwid: string | null;
  pmid: number | null;
  doi: string | null;
  source: string | null;
  externalId: string | null;
  status: string | null;
  score: number | null;
  author: string | null;
  affiliation: string | null;
  title: string | null;
  journal: string | null;
  pubType: string | null;
  entrezDate: Date | string | null;
};
export type PersonFact = {
  cwid: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  department: string | null;
};

export type PersonBuild = {
  articleId: string;
  cwid: string | null;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  campus: Campus;
  department: string | null;
  title: string | null;
  attribution: Attribution;
  /** An open review-queue row names this person on this paper. Always true for
   *  'review_queue'; may also be true for 'pending' (a suggestion AND a queue
   *  row), which is why it is its own fact and not read off `attribution`. */
  inReviewQueue: boolean;
  reciterScore: number | null;
};

/** What a review-queue row knows about a paper that has no other source of facts. */
export type ReviewFacts = Pick<ReviewRow, "title" | "journal" | "pubType" | "entrezDate" | "doi">;

const RANK: Record<Attribution, number> = { confirmed: 0, pending: 1, review_queue: 2 };

function clean(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  // reciterdb has columns whose DEFAULT is the literal string 'NULL'.
  return t && t !== "NULL" && t !== "'NULL'" ? t : null;
}

/**
 * Attach our people to the flagged articles.
 *
 * `flaggedIds` are the article ids that have a match row or a funding flag;
 * rows for any other article are dropped. One row per (article, person): a
 * person confirmed on a paper is never also listed as pending or in the review
 * queue for it, and pending beats review queue (the queue row is kept as
 * `inReviewQueue` on the pending row).
 *
 * A row keyed only by `DOI:<doi>` is folded onto the article that carries that
 * DOI under a real id, exactly as reciterdb's `build_scope` does: the DOI map
 * is built from ALL three sources before anything is attached, so neither the
 * order of the rows nor which source names the article matters.
 *
 * `names` are every person's name keys ({@link nameKeysByCwid}); they decide
 * whether a review row with no proposed person repeats someone already on the
 * paper. The three sources are read twice, so they must be re-iterable.
 */
export function attachPeople(input: {
  flaggedIds: Iterable<string>;
  accepted: Iterable<AcceptedRow>;
  pending: Iterable<PendingRow>;
  review: Iterable<ReviewRow>;
  persons: ReadonlyMap<string, PersonFact>;
  ithaca: ReadonlySet<string>;
  names?: ReadonlyMap<string, readonly NameKey[]>;
}): { people: PersonBuild[]; reviewFacts: Map<string, ReviewFacts> } {
  // One spelling per primary-key value, as the match tables hold it.
  const flagged = new Map<string, string>();
  for (const id of input.flaggedIds) if (!flagged.has(ci(id))) flagged.set(ci(id), id);
  const byKey = new Map<string, PersonBuild>();
  /** ci(article id) → the people with a cwid attached to it. */
  const withCwid = new Map<string, PersonBuild[]>();
  const reviewFacts = new Map<string, ReviewFacts>();

  const isOpen = (r: ReviewRow) => r.status === "open";
  const isPending = (r: PendingRow) => isPendingAssertion(r.userAssertion);

  // Pass 1 — reciterdb's scope: every article key in the three sources, with
  // the first DOI seen for it; then doi → the first non-DOI key carrying it.
  const scopeDoi = new Map<string, { key: string; doi: string | null }>();
  const note = (key: string | null, doi: string | null) => {
    if (!key) return;
    const entry = scopeDoi.get(ci(key));
    if (!entry) scopeDoi.set(ci(key), { key, doi });
    else entry.doi ??= doi;
  };
  for (const r of input.accepted) note(articleKey(r), normDoi(r.doi));
  for (const r of input.pending) if (isPending(r)) note(articleKey(r), normDoi(r.doi));
  for (const r of input.review) if (isOpen(r)) note(articleKey(r), normDoi(r.doi));
  /** doi → the article key a `DOI:<doi>` row folds onto. */
  const byDoi = new Map<string, string>();
  for (const { key, doi } of scopeDoi.values()) {
    if (doi && !key.startsWith("DOI:") && !byDoi.has(doi)) byDoi.set(doi, key);
  }

  const resolve = (key: string | null): string | null => {
    if (!key) return null;
    // A DOI: key with a fold target has no rows of its own in reciterdb.
    const target = key.startsWith("DOI:") ? byDoi.get(key.slice("DOI:".length)) : undefined;
    return flagged.get(ci(target ?? key)) ?? null;
  };

  const add = (
    articleId: string,
    attribution: Attribution,
    rawCwid: string | null,
    score: number | null,
    review?: ReviewRow,
  ) => {
    const cwidLower = clean(rawCwid)?.toLowerCase() ?? null;
    if (isExternalCohort(cwidLower)) return;
    const fact = cwidLower ? input.persons.get(cwidLower) : undefined;
    const author = clean(review?.author);
    // A review row with no proposed person and no byline name identifies nobody.
    if (!cwidLower && !author) return;
    const onArticle = withCwid.get(ci(articleId)) ?? [];
    if (!cwidLower) {
      // The same authorship as someone already listed, under the byline
      // spelling: not a second person. The queue row is still a fact about them.
      const same = onArticle.filter((p) =>
        bylineCouldBe(author, input.names?.get(p.cwid!.toLowerCase()) ?? []),
      );
      if (same.length > 0) {
        for (const p of same) if (p.attribution !== "confirmed") p.inReviewQueue = true;
        return;
      }
    }
    const key = `${ci(articleId)}|${cwidLower ?? `?${author!.toLowerCase()}`}`;
    const existing = byKey.get(key);
    if (existing && RANK[existing.attribution] <= RANK[attribution]) {
      if (existing.attribution === attribution && score != null)
        existing.reciterScore = Math.max(existing.reciterScore ?? score, score);
      if (attribution === "review_queue" && existing.attribution !== "confirmed")
        existing.inReviewQueue = true;
      return;
    }
    const first = clean(fact?.firstName);
    const last = clean(fact?.lastName);
    const built: PersonBuild = {
      articleId,
      cwid: cwidLower ? (fact?.cwid ?? cwidLower) : null,
      displayName: [first, last].filter(Boolean).join(" ") || cwidLower || author!,
      firstName: first,
      lastName: last,
      // 'ithaca' comes from the person-type set and from nothing else.
      campus: cwidLower ? (input.ithaca.has(cwidLower) ? "ithaca" : "wcm") : "unknown",
      department: clean(fact?.department),
      title: clean(fact?.title),
      attribution,
      inReviewQueue:
        attribution === "review_queue" || (attribution === "pending" && existing?.inReviewQueue === true),
      reciterScore: attribution === "confirmed" ? null : score,
    };
    byKey.set(key, built);
    if (cwidLower) withCwid.set(ci(articleId), [...onArticle.filter((p) => p !== existing), built]);
  };

  // Pass 2 — attach.
  for (const r of input.accepted) {
    const id = resolve(articleKey(r));
    if (id) add(id, "confirmed", r.cwid, null);
  }
  for (const r of input.pending) {
    if (!isPending(r)) continue;
    const id = resolve(articleKey(r));
    if (id) add(id, "pending", r.cwid, r.score);
  }
  // Review rows that name a person first, so a row that names nobody can be
  // compared with everyone already on the paper.
  const unnamed: Array<[string, ReviewRow]> = [];
  for (const r of input.review) {
    if (!isOpen(r)) continue;
    const id = resolve(articleKey(r));
    if (!id) continue;
    if (!reviewFacts.has(id)) reviewFacts.set(id, r);
    if (clean(r.cwid)) add(id, "review_queue", r.cwid, r.score, r);
    else unnamed.push([id, r]);
  }
  for (const [id, r] of unnamed) add(id, "review_queue", null, r.score, r);
  return { people: [...byKey.values()], reviewFacts };
}

// ---------------------------------------------------------------------------
// Article rows
// ---------------------------------------------------------------------------

export type ArticleFact = {
  pmid: number | null;
  articleId: string | null;
  title: string | null;
  journal: string | null;
  /** `pubDate` (DATE) when set, else `publicationDateStandardized` (string). */
  publicationDate: Date | string | null;
  publicationType: string | null;
  doi: string | null;
};

export type ArticleBuild = {
  articleId: string;
  pmid: number | null;
  title: string | null;
  journal: string | null;
  publicationDate: Date | null;
  publicationType: string | null;
  totalAuthors: number;
  doi: string | null;
  source: string;
  lastRefreshedAt: Date;
};

/** A calendar date at UTC midnight (what a `@db.Date` column stores), or null
 *  for anything that is not a real date. Year-only and year-month strings take
 *  the first day. */
export function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(v.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2] ?? 1), Number(m[3] ?? 1)];
  if (year < 1800 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

/** One article row per id that has a person attached. Facts come from the
 *  article tables; a paper known only to the review queue falls back to what
 *  its review row carries (the Entrez date stands in for the publication date). */
export function buildArticles(
  articleIds: Iterable<string>,
  facts: ReadonlyMap<string, ArticleFact>,
  reviewFacts: ReadonlyMap<string, ReviewFacts>,
  nAuthors: ReadonlyMap<string, number>,
  now: Date,
): ArticleBuild[] {
  const out: ArticleBuild[] = [];
  for (const articleId of new Set(articleIds)) {
    const f = facts.get(ci(articleId));
    const r = reviewFacts.get(articleId);
    out.push({
      articleId,
      pmid: /^\d+$/.test(articleId) ? Number(articleId) : null,
      title: clean(f?.title) ?? clean(r?.title),
      journal: (clean(f?.journal) ?? clean(r?.journal))?.slice(0, 512) ?? null,
      publicationDate: toDate(f?.publicationDate) ?? toDate(r?.entrezDate),
      publicationType: (clean(f?.publicationType) ?? clean(r?.pubType))?.slice(0, 128) ?? null,
      totalAuthors: nAuthors.get(ci(articleId)) ?? 0,
      doi: normDoi(f?.doi) ?? normDoi(r?.doi),
      source: sourceOf(articleId),
      lastRefreshedAt: now,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Empty-source guard
// ---------------------------------------------------------------------------

/** Fewer match rows than this is a rebuild in progress or a table that was
 *  never loaded, not a real night (a normal night is tens of thousands). */
export const MIN_SOURCE_MATCH_ROWS = 1000;

/**
 * Refuse to replace the dashboard's tables with an empty or implausibly small
 * set. Throws `EtlGuardError`; the caller has written nothing yet, so
 * yesterday's copy stays and the step fails loudly.
 */
export function assertPlausibleSource(v: {
  sourceMatchRows: number;
  builtArticles: number;
  existingArticles: number;
}): void {
  assertSourceVolume("research-security:source", {
    incoming: v.sourceMatchRows,
    floor: MIN_SOURCE_MATCH_ROWS,
  });
  assertSourceVolume("research-security:full-replace", {
    incoming: v.builtArticles,
    existing: v.existingArticles,
    floor: 1,
    maxDropPct: 50,
  });
}
