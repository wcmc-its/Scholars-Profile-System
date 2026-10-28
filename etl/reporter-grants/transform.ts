/**
 * Pure transforms for the RePORTER grant materializer (`etl/reporter-grants`).
 *
 * Kept side-effect-free (no DB, no fetch) so the orchestration in `index.ts`
 * stays thin and these decision bits are unit-testable in isolation. The
 * dedup/labeling logic lives one module over in `@/lib/edit/reporter-grants`
 * (shared with the CV generator) and is already tested there — this file only
 * owns the FY-collapse grouping, the deterministic Grant-row mapping, and the
 * recency gate.
 */
import { parseNihAward } from "@/lib/award-number";
import { repairEncodingOrNull } from "@/lib/text/repair-encoding";
import type { ReporterProject } from "@/lib/edit/reporter-grants";
import type { ReporterGrantProject, ReporterPI } from "@/etl/nih-profile/fetcher";

/**
 * Net-new RePORTER grants are inherently old (the whole point — prior-institution
 * and dropped WCM history; measured median age ~16y). Materialize them all, but
 * default-hide any whose last fiscal year is older than this rolling window via a
 * system `Suppression` (spec §6c). 25y keeps ~82% of net-new visible while hiding
 * the 1980s–90s tail. A constant, not config (spec §6c).
 */
export const RECENCY_YEARS = 25;

/** True when a grant should be default-hidden by age: its most recent fiscal
 *  year is more than RECENCY_YEARS behind the current year. Rolling, not a
 *  calendar anchor — a long-running grant stays visible off its latest FY. A
 *  grant with no resolvable fiscal year is left visible (we can't date it). */
export function recencyShouldSuppress(
  maxFiscalYear: number | null,
  currentYear: number,
): boolean {
  if (maxFiscalYear === null) return false;
  return currentYear - maxFiscalYear > RECENCY_YEARS;
}

/**
 * #3071 — `person_nih_profile.resolution_source` values that mean the profile_id
 * was linked to the scholar by NAME alone. A same-named investigator elsewhere
 * then brings their whole NIH portfolio onto the WCM profile.
 */
export const NAME_ONLY_RESOLUTION_SOURCES: ReadonlySet<string> = new Set([
  "name_query",
  "name_match",
]);

/** True when any of a scholar's profile rows was resolved by name alone. Any,
 *  not all: the materializer unions every profile_id a scholar has, so one
 *  name-only row is enough to bring in another person's awards. */
export function hasNameOnlyProfile(resolutionSources: Iterable<string>): boolean {
  for (const s of resolutionSources) if (NAME_ONLY_RESOLUTION_SOURCES.has(s)) return true;
  return false;
}

/**
 * #3071 case D — `person_nih_profile.resolution_source` values that mean the
 * profile_id was linked through a WCM grant row joined to a RePORTER project,
 * then a name check (`namesMatch`: same surname plus one matching token or
 * initial). A different WCM investigator with a similar name passes that check,
 * and every one of THEIR awards is WCM-administered, so WCM in the award's org
 * history says nothing about which WCM person it belongs to.
 */
export const GRANT_JOIN_RESOLUTION_SOURCES: ReadonlySet<string> = new Set([
  "grant_join_contact",
  "grant_join_pi",
]);

/**
 * #3071 — what must tie a scholar's RePORTER awards to them before they show.
 *   - "none": no name-only or grant-join profile (e.g. every profile was
 *     confirmed by publications, pmid-overlap-*). Never hidden here.
 *   - "wcm-or-publication": a name-only profile (name_query / name_match). The
 *     failure is a same-named investigator ELSEWHERE, so WCM in the award's org
 *     history is enough, as is a confirmed linked publication.
 *   - "publication-only": a grant-join profile. The failure is another WCM
 *     person, so only a confirmed publication linked to the award counts.
 * Strictest wins: the materializer unions every profile_id a scholar has into
 * one fetch, so an award can't be traced back to the profile that brought it,
 * and a grant-join profile next to a name-only one can still bring in another
 * WCM person's awards.
 */
/** A profile matched by neither name alone nor a WCM grant join: the v2
 *  PMID-overlap matcher's sources, or a curator's link. Cue 8 trusts such a
 *  profile's awards. */
export function isPublicationMatchedSource(resolutionSource: string): boolean {
  return (
    !NAME_ONLY_RESOLUTION_SOURCES.has(resolutionSource) &&
    !GRANT_JOIN_RESOLUTION_SOURCES.has(resolutionSource)
  );
}

export type CorroborationPolicy = "none" | "wcm-or-publication" | "publication-only";

export function corroborationPolicy(resolutionSources: Iterable<string>): CorroborationPolicy {
  const sources = [...resolutionSources];
  if (sources.some((s) => GRANT_JOIN_RESOLUTION_SOURCES.has(s))) return "publication-only";
  if (hasNameOnlyProfile(sources)) return "wcm-or-publication";
  return "none";
}

/** One award (all its fiscal years collapsed) for one scholar. */
export interface GroupedProject {
  coreProjectNum: string;
  /** project_num of the most recent fiscal year — for display/award-number. */
  awardNumber: string | null;
  /** appl_id of the most recent fiscal year — keys the RePORTER project-detail
   *  outbound link (`nihReporterProjectUrl`). */
  applId: number | null;
  /** Grantee org, preferring WCM when any fiscal year was WCM-administered — so
   *  `isWcmOrg(orgName)` is true iff WCM is anywhere in the award's org history. */
  orgName: string | null;
  title: string | null;
  startDate: Date | null;
  endDate: Date | null;
  maxFiscalYear: number | null;
  /** Summed across fiscal years. Not persisted (the Grant schema has no $) —
   *  carried for the dedup shape and possible CV-side display. */
  awardAmount: number | null;
  /** #3071 — every (org, fiscal year) the award was held at, for the
   *  prior-institution cue. `orgName` above keeps only one. */
  orgHistory: Array<{ orgName: string | null; fiscalYear: number | null }>;
  /** #3071 — every PI across the fiscal years, one per profile_id. */
  pis: ReporterPI[];
}

export const isWcmOrg = (org: string | null | undefined): boolean =>
  /weill|cornell/i.test(org ?? "");

/** #3071 — institutions whose faculty often hold WCM appointments, as RePORTER
 *  prints them, with the name the evidence shows. */
export const WCM_AFFILIATES: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /sloan[\s-]*kettering/i, name: "Memorial Sloan Kettering" },
  { pattern: /new york[\s-]*presbyterian|society of the new york hosp/i, name: "NewYork-Presbyterian" },
  { pattern: /hospital for special surgery/i, name: "Hospital for Special Surgery" },
  { pattern: /rockefeller univ/i, name: "Rockefeller University" },
];

/** The WCM affiliate anywhere in the award's org history, or null. Pure. */
export function affiliateOrgMatch(
  orgHistory: ReadonlyArray<{ orgName: string | null }>,
): string | null {
  for (const o of orgHistory)
    for (const a of WCM_AFFILIATES) if (o.orgName && a.pattern.test(o.orgName)) return a.name;
  return null;
}

function parseReporterDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Collapse a scholar's per-fiscal-year RePORTER project rows into one entry per
 * core_project_num: earliest start, latest end, summed amount, most-recent
 * title/award-number, org preferring WCM. Rows without a core_project_num are
 * dropped (can't be keyed or deduped). Pure.
 */
export function groupProjectsByCore(
  projects: ReporterGrantProject[],
): GroupedProject[] {
  type Acc = GroupedProject & { latestFyForMeta: number; piIds: Set<number> };
  const addHistory = (acc: Acc, p: ReporterGrantProject, fy: number | null) => {
    acc.orgHistory.push({ orgName: p.org_name ?? null, fiscalYear: fy });
    for (const pi of p.principal_investigators ?? []) {
      if (acc.piIds.has(pi.profile_id)) continue;
      acc.piIds.add(pi.profile_id);
      acc.pis.push(pi);
    }
  };
  const byCore = new Map<string, Acc>();

  for (const p of projects) {
    const core = p.core_project_num?.toUpperCase();
    if (!core) continue;
    const start = parseReporterDate(p.project_start_date);
    const end = parseReporterDate(p.project_end_date);
    const fy = typeof p.fiscal_year === "number" ? p.fiscal_year : null;

    const existing = byCore.get(core);
    if (!existing) {
      const acc: Acc = {
        coreProjectNum: core,
        awardNumber: p.project_num ?? null,
        applId: p.appl_id ?? null,
        orgName: p.org_name ?? null,
        title: p.project_title ?? null,
        startDate: start,
        endDate: end,
        maxFiscalYear: fy,
        awardAmount: p.award_amount ?? null,
        orgHistory: [],
        pis: [],
        latestFyForMeta: fy ?? -Infinity,
        piIds: new Set(),
      };
      addHistory(acc, p, fy);
      byCore.set(core, acc);
      continue;
    }
    addHistory(existing, p, fy);

    if (start && (!existing.startDate || start < existing.startDate)) {
      existing.startDate = start;
    }
    if (end && (!existing.endDate || end > existing.endDate)) {
      existing.endDate = end;
    }
    if (fy !== null && (existing.maxFiscalYear === null || fy > existing.maxFiscalYear)) {
      existing.maxFiscalYear = fy;
    }
    if (typeof p.award_amount === "number") {
      existing.awardAmount = (existing.awardAmount ?? 0) + p.award_amount;
    }
    // Most-recent fiscal year wins for the display title + award number.
    if (fy !== null && fy >= existing.latestFyForMeta) {
      existing.latestFyForMeta = fy;
      if (p.project_num) existing.awardNumber = p.project_num;
      if (p.appl_id) existing.applId = p.appl_id;
      if (p.project_title) existing.title = p.project_title;
    }
    // Prefer a WCM org over a non-WCM one for labeling/dedup.
    if (isWcmOrg(p.org_name) && !isWcmOrg(existing.orgName)) {
      existing.orgName = p.org_name ?? existing.orgName;
    }
  }

  return [...byCore.values()].map((acc) => ({
    coreProjectNum: acc.coreProjectNum,
    awardNumber: acc.awardNumber,
    applId: acc.applId,
    orgName: acc.orgName,
    title: acc.title,
    startDate: acc.startDate,
    endDate: acc.endDate,
    maxFiscalYear: acc.maxFiscalYear,
    awardAmount: acc.awardAmount,
    orgHistory: acc.orgHistory,
    pis: acc.pis,
  }));
}

/** Project a grouped award into the dedup input shape consumed by
 *  `dedupeAgainstInfoEd`. */
export function toReporterProject(g: GroupedProject): ReporterProject {
  return {
    coreProjectNum: g.coreProjectNum,
    awardNumber: g.awardNumber ?? "",
    orgName: g.orgName,
    fiscalYear: g.maxFiscalYear,
    awardAmount: g.awardAmount,
    title: g.title,
  };
}

/** The Grant columns this ETL writes. `id === externalId` (the deterministic
 *  key) so the externalId-keyed suppression machinery resolves these rows
 *  without change. The funding index does NOT parse this form with
 *  `parseExternalId` (InfoEd-only); it keys these rows through
 *  `fundingProjectBaseKey` (lib/funding-projection.ts), which reads the core
 *  project number out of the third segment — #2285. Change this format and
 *  that parser must change with it. */
export interface ReporterGrantRow {
  id: string;
  externalId: string;
  cwid: string;
  source: "RePORTER";
  role: "PI";
  title: string;
  funder: string;
  mechanism: string | null;
  nihIc: string | null;
  startDate: Date;
  endDate: Date;
  awardNumber: string | null;
  programType: string;
}

/**
 * Map a grouped net-new award to a deterministic `Grant` row. Returns null when
 * the award has no usable project period — startDate/endDate are NOT NULL @db.Date
 * columns, so an undated award can't be persisted (skip + warn upstream). NIH IC
 * and mechanism come from the clean core_project_num (not the annotated
 * project_num, which can defeat the award-number regex). Pure.
 */
export function buildReporterGrantRow(
  cwid: string,
  g: GroupedProject,
): ReporterGrantRow | null {
  if (!g.startDate || !g.endDate) return null;
  const core = g.coreProjectNum;
  const { mechanism, nihIc } = parseNihAward(core);
  const id = `reporter:${cwid}:${core}`;
  return {
    id,
    externalId: id,
    cwid,
    source: "RePORTER",
    role: "PI",
    title: repairEncodingOrNull(g.title?.trim()) || `(untitled grant ${core})`,
    funder: nihIc ?? "NIH",
    mechanism,
    nihIc,
    startDate: g.startDate,
    endDate: g.endDate,
    awardNumber: repairEncodingOrNull(g.awardNumber),
    programType: "Grant",
  };
}
