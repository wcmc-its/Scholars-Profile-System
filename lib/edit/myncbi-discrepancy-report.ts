/**
 * Report 16 — NIH bibliography discrepancies: loader + params. Compares each
 * scholar's public MyNCBI bibliography (`myncbi_citation`, etl/myncbi — URLs from
 * their own NIH biosketches) with their confirmed SPS publications
 * (`publication_author.is_confirmed`). Superusers only (the registry's "superuser" gate).
 *
 * Per scholar:
 *  - `missing` — PMIDs on their MyNCBI list SPS has not confirmed for them. The
 *    actionable direction: they claimed the paper to NIH.
 *  - `extra` — confirmed in SPS, absent from the list. Weaker: many people never
 *    curate their MyNCBI list.
 * Citations without a PMID (books, reports) are not compared.
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
>;

/** Scholars listed at most; the totals always count everyone. */
export const MYNCBI_DISCREPANCY_LIST_CAP = 300;
/** "On profile, not on list" items titled per scholar; the count is always whole. */
export const MYNCBI_EXTRA_TITLE_CAP = 25;

export const MYNCBI_DISCREPANCY_SHOW = ["missing", "all"] as const;
export type MyncbiDiscrepancyShow = (typeof MYNCBI_DISCREPANCY_SHOW)[number];
export const MYNCBI_DISCREPANCY_SHOW_LABEL: Record<MyncbiDiscrepancyShow, string> = {
  missing: "Missing from profile",
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

export type CitationItem = { pmid: string; title: string; source: string | null; year: number | null };

export type MyncbiDiscrepancyScholar = {
  cwid: string;
  name: string;
  department: string | null;
  url: string;
  fetchedAt: string;
  /** PMIDs on the list (citations without one are not compared). */
  listed: number;
  matched: number;
  missing: CitationItem[];
  extraCount: number;
  /** Newest first, at most MYNCBI_EXTRA_TITLE_CAP; filled for listed scholars only. */
  extra: CitationItem[];
};

export type MyncbiDiscrepancyReport = {
  totals: { scholars: number; listed: number; matched: number; missing: number; withMissing: number; extra: number };
  scholars: MyncbiDiscrepancyScholar[];
  /** Matching scholars before the list cap. */
  matched: number;
};

/** Pure: one scholar's list vs their confirmed PMIDs. Missing sorted newest first. */
export function compareBibliography(
  list: readonly CitationItem[],
  confirmed: ReadonlySet<string>,
): { listed: number; matched: number; missing: CitationItem[]; extraPmids: string[] } {
  const byPmid = new Map(list.map((c) => [c.pmid, c]));
  const missing = [...byPmid.values()]
    .filter((c) => !confirmed.has(c.pmid))
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  return {
    listed: byPmid.size,
    matched: byPmid.size - missing.length,
    missing,
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
      scholar: { select: { preferredName: true, primaryDepartment: true } },
    },
  });
  const cwids = bibs.map((b) => b.cwid);
  const [citations, confirmedRows] = await Promise.all([
    client.myncbiCitation.findMany({
      where: { cwid: { in: cwids }, pmid: { not: null } },
      select: { cwid: true, pmid: true, title: true, source: true, year: true },
    }),
    client.publicationAuthor.findMany({
      where: { cwid: { in: cwids }, isConfirmed: true },
      select: { cwid: true, pmid: true, publication: { select: { year: true } } },
    }),
  ]);
  const listOf = new Map<string, CitationItem[]>();
  for (const c of citations) {
    const l = listOf.get(c.cwid) ?? listOf.set(c.cwid, []).get(c.cwid)!;
    l.push({ pmid: c.pmid!, title: c.title, source: c.source, year: c.year });
  }
  // Newest first, so the "not on list" side can be cut before its titles are read.
  confirmedRows.sort((a, b) => (b.publication.year ?? 0) - (a.publication.year ?? 0));
  const confirmedOf = new Map<string, Set<string>>();
  for (const r of confirmedRows) {
    if (r.cwid) (confirmedOf.get(r.cwid) ?? confirmedOf.set(r.cwid, new Set()).get(r.cwid)!).add(r.pmid);
  }

  const all = bibs.map((b) => {
    const cmp = compareBibliography(listOf.get(b.cwid) ?? [], confirmedOf.get(b.cwid) ?? new Set());
    return {
      cwid: b.cwid,
      name: b.scholar.preferredName,
      department: b.scholar.primaryDepartment,
      url: b.url,
      fetchedAt: b.fetchedAt.toISOString(),
      listed: cmp.listed,
      matched: cmp.matched,
      missing: cmp.missing,
      extraCount: cmp.extraPmids.length,
      extraPmids: cmp.extraPmids,
    };
  });
  // Most missing first: that is where the curation work is.
  all.sort((a, b) => b.missing.length - a.missing.length || a.name.localeCompare(b.name));
  const matching = p.show === "missing" ? all.filter((s) => s.missing.length > 0) : all;
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
      missing: all.reduce((n, s) => n + s.missing.length, 0),
      withMissing: all.filter((s) => s.missing.length > 0).length,
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
