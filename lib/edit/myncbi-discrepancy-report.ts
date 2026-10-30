/**
 * Report 16 — NIH bibliography discrepancies: loader + params. Compares each
 * scholar's public MyNCBI bibliography (`myncbi_citation`, etl/myncbi — URLs from
 * their own NIH biosketches) with their confirmed SPS publications
 * (`publication_author.is_confirmed`). Superusers only (the registry's "superuser" gate).
 *
 * Per scholar:
 *  - `missing` — PMIDs on their MyNCBI list, naming them as an author, that SPS has
 *    not confirmed for them. The actionable direction: they claimed the paper to NIH.
 *  - `notAuthored` — PMIDs on the list whose authors do not include the scholar's
 *    surname. MyNCBI is also where PIs link papers to awards for NIH reporting, so a
 *    lab head's or training-grant PI's list carries trainees' and members' papers.
 *    Not a gap; shown apart and left out of the totals.
 *  - `extra` — confirmed in SPS, absent from the list. Weaker: many people never
 *    curate their MyNCBI list.
 * Citations without a PMID (books, reports) are not compared.
 *
 * Each missing item carries its ReCiter state (`reciter`), which is what the
 * curator does about it in Publication Manager: `pending` → accept it, `rejected`
 * → someone said "not mine" though the scholar claims it to NIH, so review it,
 * `none` → not a ReCiter candidate, so add it. Read from the nightly mirrors
 * `reciter_pending_pmid` / `reciter_rejected_pmid`.
 *
 * A list that barely overlaps the profile (`suspect`) is most likely someone
 * else's — a co-investigator's link picked up with the biosketch. Those sit in
 * their own view and stay out of the missing totals.
 *
 * Read-only.
 */
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import {
  loadSelectedDivisionRosterCwids,
  parsePersonFilter,
  personFilterWhere,
  type PersonFilter,
} from "@/lib/edit/person-filter";

type Client = Pick<
  PrismaClient,
  "myncbiBibliography" | "myncbiCitation" | "publicationAuthor" | "publication" | "scholar" | "division" | "divisionMembership"
  | "reciterPendingPmid"
  | "reciterRejectedPmid"
>;

/** Scholars listed at most; the totals always count everyone. */
export const MYNCBI_DISCREPANCY_LIST_CAP = 300;
/** "On profile, not on list" items titled per scholar; the count is always whole. */
export const MYNCBI_EXTRA_TITLE_CAP = 25;
/** Below this share of listed PMIDs confirmed on the profile, the list is suspect. */
export const MYNCBI_SUSPECT_OVERLAP = 0.2;
/** Never suspect when the list or the profile has fewer PMIDs than this: too
 *  little to judge, and a profile with nothing confirmed is the gap itself. */
export const MYNCBI_SUSPECT_MIN = 5;

export const MYNCBI_DISCREPANCY_SHOW = ["missing", "suspect", "all"] as const;
export type MyncbiDiscrepancyShow = (typeof MYNCBI_DISCREPANCY_SHOW)[number];
export const MYNCBI_DISCREPANCY_SHOW_LABEL: Record<MyncbiDiscrepancyShow, string> = {
  missing: "Missing from profile",
  suspect: "List may be someone else's",
  all: "Everyone with a bibliography",
};

export type MyncbiDiscrepancyParams = PersonFilter & { q: string; show: MyncbiDiscrepancyShow };

export function parseMyncbiDiscrepancyParams(
  sp: Record<string, string | string[] | undefined>,
): MyncbiDiscrepancyParams {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  };
  const show = one("show");
  return {
    ...parsePersonFilter(sp),
    q: one("q").slice(0, 100),
    show: (MYNCBI_DISCREPANCY_SHOW as readonly string[]).includes(show) ? (show as MyncbiDiscrepancyShow) : "missing",
  };
}

export type CitationItem = {
  pmid: string;
  title: string;
  source: string | null;
  year: number | null;
  /** MyNCBI's author list; absent on profile-side items and on rows fetched before it was stored. */
  authors?: string | null;
  /** Missing items only: where the paper stands in ReCiter. */
  reciter?: ReciterState;
};

export type ReciterState = "pending" | "rejected" | "none";

const pairKey = (cwid: string, pmid: string) => `${cwid}\t${pmid}`;

/** Pure: a `(cwid, pmid)` set from mirror rows, for `withReciterState`. */
export const pairSet = (rows: readonly { cwid: string; pmid: string }[]) =>
  new Set(rows.map((r) => pairKey(r.cwid, r.pmid)));

/** Pure: tag one scholar's missing items with their ReCiter state. A rejection wins over a stale pending row. */
export function withReciterState(
  cwid: string,
  items: readonly CitationItem[],
  pending: ReadonlySet<string>,
  rejected: ReadonlySet<string>,
): CitationItem[] {
  return items.map((c) => {
    const k = pairKey(cwid, c.pmid);
    return { ...c, reciter: rejected.has(k) ? "rejected" : pending.has(k) ? "pending" : "none" };
  });
}

const SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv", "md", "phd"]);
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

/** Pure: surname parts to look for, from the last word of each name ("Alia-Klein" → alia, klein). */
export function surnameKeys(...names: (string | null | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const n of names) {
    const words = (n ?? "").split(/\s+/).map((w) => w.replace(/[.,]/g, "")).filter((w) => w && !SUFFIX.has(fold(w)));
    for (const part of (words.at(-1) ?? "").split("-")) if (fold(part).length > 1) keys.add(fold(part));
  }
  return [...keys];
}

/**
 * Pure: whether a MyNCBI author list ("Ceceli AO, Alia-Klein N, Goldstein RZ")
 * names someone with one of these surnames. Unknown authors count as authored, so a
 * row fetched before authors were stored stays a gap rather than vanishing.
 * ponytail: surname only; a changed name or a same-surname coauthor misclassifies.
 */
export function authoredBy(authors: string | null | undefined, keys: readonly string[]): boolean {
  if (!authors || keys.length === 0) return true;
  return authors.split(",").some((a) => {
    const words = a.trim().split(/\s+/);
    // Drop the trailing initials ("RZ"); keep a one-word collective name whole.
    const surname = words.length > 1 && /^[A-Z]{1,4}$/.test(words.at(-1)!) ? words.slice(0, -1) : words;
    return surname.flatMap((w) => w.split("-")).some((w) => keys.includes(fold(w)));
  });
}

export type MyncbiDiscrepancyScholar = {
  cwid: string;
  name: string;
  department: string | null;
  url: string;
  fetchedAt: string;
  /** PMIDs on the list (citations without one are not compared). */
  listed: number;
  matched: number;
  /** Too little of the list is on the profile to trust it as theirs. */
  suspect: boolean;
  missing: CitationItem[];
  /** On the list without the scholar among the authors (grant-linked papers). */
  notAuthored: CitationItem[];
  extraCount: number;
  /** Newest first, at most MYNCBI_EXTRA_TITLE_CAP; filled for listed scholars only. */
  extra: CitationItem[];
};

export type MyncbiDiscrepancyReport = {
  /** `missing` / `withMissing` leave suspect lists out; `suspect` counts them. */
  totals: {
    scholars: number;
    listed: number;
    matched: number;
    missing: number;
    withMissing: number;
    /** `missing` split by ReCiter state. */
    byReciter: Record<ReciterState, number>;
    notAuthored: number;
    suspect: number;
    extra: number;
  };
  scholars: MyncbiDiscrepancyScholar[];
  /** Matching scholars before the list cap. */
  matched: number;
};

/** Pure: whether a list overlaps the profile too little to be theirs. */
export const isSuspectList = (listed: number, matched: number, confirmed: number) =>
  listed >= MYNCBI_SUSPECT_MIN && confirmed >= MYNCBI_SUSPECT_MIN && matched / listed < MYNCBI_SUSPECT_OVERLAP;

/** Pure: one scholar's list vs their confirmed PMIDs. Missing and notAuthored sorted newest first. */
export function compareBibliography(
  list: readonly CitationItem[],
  confirmed: ReadonlySet<string>,
  surnames: readonly string[] = [],
): {
  listed: number;
  matched: number;
  confirmed: number;
  missing: CitationItem[];
  notAuthored: CitationItem[];
  extraPmids: string[];
} {
  const byPmid = new Map(list.map((c) => [c.pmid, c]));
  const unconfirmed = [...byPmid.values()]
    .filter((c) => !confirmed.has(c.pmid))
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  const missing = unconfirmed.filter((c) => authoredBy(c.authors, surnames));
  return {
    listed: byPmid.size,
    matched: byPmid.size - unconfirmed.length,
    confirmed: confirmed.size,
    missing,
    notAuthored: unconfirmed.filter((c) => !missing.includes(c)),
    // Keeps `confirmed`'s order (the loader passes it newest first).
    extraPmids: [...confirmed].filter((p) => !byPmid.has(p)),
  };
}

export async function loadMyncbiDiscrepancyReport(
  client: Client,
  p: MyncbiDiscrepancyParams,
): Promise<MyncbiDiscrepancyReport> {
  const roster = await loadSelectedDivisionRosterCwids(client, p.unitValues);
  const w = personFilterWhere({ types: p.types, unitValues: p.unitValues }, [], roster);
  const and: Prisma.ScholarWhereInput[] = [{ deletedAt: null }];
  if (w.roleCategory) and.push({ roleCategory: w.roleCategory });
  if (w.unit) and.push(w.unit);
  if (p.q) and.push({ OR: [{ preferredName: { contains: p.q } }, { cwid: { startsWith: p.q } }] });

  // Only lists we hold: an "empty" or "error" fetch keeps no citations to compare.
  const bibs = await client.myncbiBibliography.findMany({
    where: { status: "ok", scholar: { AND: and } },
    select: {
      cwid: true,
      url: true,
      fetchedAt: true,
      scholar: { select: { preferredName: true, fullName: true, primaryDepartment: true } },
    },
  });
  const cwids = bibs.map((b) => b.cwid);
  const [citations, confirmedRows, pendingRows, rejectedRows] = await Promise.all([
    client.myncbiCitation.findMany({
      where: { cwid: { in: cwids }, pmid: { not: null } },
      select: { cwid: true, pmid: true, authors: true, title: true, source: true, year: true },
    }),
    client.publicationAuthor.findMany({
      where: { cwid: { in: cwids }, isConfirmed: true },
      select: { cwid: true, pmid: true, publication: { select: { year: true } } },
    }),
    client.reciterPendingPmid.findMany({ where: { cwid: { in: cwids } }, select: { cwid: true, pmid: true } }),
    client.reciterRejectedPmid.findMany({ where: { cwid: { in: cwids } }, select: { cwid: true, pmid: true } }),
  ]);
  const pending = pairSet(pendingRows);
  const rejected = pairSet(rejectedRows);
  const listOf = new Map<string, CitationItem[]>();
  for (const c of citations) {
    const l = listOf.get(c.cwid) ?? listOf.set(c.cwid, []).get(c.cwid)!;
    l.push({ pmid: c.pmid!, title: c.title, source: c.source, year: c.year, authors: c.authors });
  }
  // Newest first, so the "not on list" side can be cut before its titles are read.
  confirmedRows.sort((a, b) => (b.publication.year ?? 0) - (a.publication.year ?? 0));
  const confirmedOf = new Map<string, Set<string>>();
  for (const r of confirmedRows) {
    if (r.cwid) (confirmedOf.get(r.cwid) ?? confirmedOf.set(r.cwid, new Set()).get(r.cwid)!).add(r.pmid);
  }

  const all = bibs.map((b) => {
    const cmp = compareBibliography(
      listOf.get(b.cwid) ?? [],
      confirmedOf.get(b.cwid) ?? new Set(),
      surnameKeys(b.scholar.fullName, b.scholar.preferredName),
    );
    return {
      cwid: b.cwid,
      name: b.scholar.preferredName,
      department: b.scholar.primaryDepartment,
      url: b.url,
      fetchedAt: b.fetchedAt.toISOString(),
      listed: cmp.listed,
      matched: cmp.matched,
      suspect: isSuspectList(cmp.listed, cmp.matched, cmp.confirmed),
      missing: withReciterState(b.cwid, cmp.missing, pending, rejected),
      notAuthored: cmp.notAuthored,
      extraCount: cmp.extraPmids.length,
      extraPmids: cmp.extraPmids,
    };
  });
  // Most missing first: that is where the curation work is.
  all.sort((a, b) => b.missing.length - a.missing.length || a.name.localeCompare(b.name));
  const trusted = all.filter((s) => !s.suspect);
  const matching =
    p.show === "missing"
      ? trusted.filter((s) => s.missing.length > 0)
      : p.show === "suspect"
        ? all.filter((s) => s.suspect)
        : all;
  const shown = matching.slice(0, MYNCBI_DISCREPANCY_LIST_CAP);

  // Titles for the "not on list" side, shown scholars only, newest first.
  const pubs = await client.publication.findMany({
    where: { pmid: { in: [...new Set(shown.flatMap((s) => s.extraPmids.slice(0, MYNCBI_EXTRA_TITLE_CAP)))] } },
    select: { pmid: true, title: true, journal: true, year: true },
  });
  const pubOf = new Map(pubs.map((x) => [x.pmid, x]));

  return {
    totals: {
      scholars: all.length,
      listed: all.reduce((n, s) => n + s.listed, 0),
      matched: all.reduce((n, s) => n + s.matched, 0),
      missing: trusted.reduce((n, s) => n + s.missing.length, 0),
      withMissing: trusted.filter((s) => s.missing.length > 0).length,
      byReciter: (["pending", "rejected", "none"] as const).reduce(
        (o, r) => ({ ...o, [r]: trusted.reduce((n, s) => n + s.missing.filter((c) => c.reciter === r).length, 0) }),
        {} as Record<ReciterState, number>,
      ),
      notAuthored: trusted.reduce((n, s) => n + s.notAuthored.length, 0),
      suspect: all.length - trusted.length,
      extra: all.reduce((n, s) => n + s.extraCount, 0),
    },
    scholars: shown.map(({ extraPmids, ...s }) => ({
      ...s,
      extra: extraPmids
        .slice(0, MYNCBI_EXTRA_TITLE_CAP)
        .map((pmid) => pubOf.get(pmid))
        .filter((x) => !!x)
        .map((x) => ({ pmid: x.pmid, title: x.title, source: x.journal, year: x.year })),
    })),
    matched: matching.length,
  };
}
