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
import type { ReporterProject } from "@/lib/edit/reporter-grants";
import type { ReporterGrantProject } from "@/etl/nih-profile/fetcher";

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

/** One award (all its fiscal years collapsed) for one scholar. */
export interface GroupedProject {
  coreProjectNum: string;
  /** project_num of the most recent fiscal year — for display/award-number. */
  awardNumber: string | null;
  /** Grantee org, preferring WCM when any fiscal year was WCM-administered. */
  orgName: string | null;
  title: string | null;
  startDate: Date | null;
  endDate: Date | null;
  maxFiscalYear: number | null;
  /** Summed across fiscal years. Not persisted (the Grant schema has no $) —
   *  carried for the dedup shape and possible CV-side display. */
  awardAmount: number | null;
}

const isWcmOrg = (org: string | null | undefined): boolean =>
  /weill|cornell/i.test(org ?? "");

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
  type Acc = GroupedProject & { latestFyForMeta: number };
  const byCore = new Map<string, Acc>();

  for (const p of projects) {
    const core = p.core_project_num?.toUpperCase();
    if (!core) continue;
    const start = parseReporterDate(p.project_start_date);
    const end = parseReporterDate(p.project_end_date);
    const fy = typeof p.fiscal_year === "number" ? p.fiscal_year : null;

    const existing = byCore.get(core);
    if (!existing) {
      byCore.set(core, {
        coreProjectNum: core,
        awardNumber: p.project_num ?? null,
        orgName: p.org_name ?? null,
        title: p.project_title ?? null,
        startDate: start,
        endDate: end,
        maxFiscalYear: fy,
        awardAmount: p.award_amount ?? null,
        latestFyForMeta: fy ?? -Infinity,
      });
      continue;
    }

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
    orgName: acc.orgName,
    title: acc.title,
    startDate: acc.startDate,
    endDate: acc.endDate,
    maxFiscalYear: acc.maxFiscalYear,
    awardAmount: acc.awardAmount,
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
 *  key) so the externalId-keyed suppression + funding-index machinery resolves
 *  these rows without change. */
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
    title: g.title?.trim() || `(untitled grant ${core})`,
    funder: nihIc ?? "NIH",
    mechanism,
    nihIc,
    startDate: g.startDate,
    endDate: g.endDate,
    awardNumber: g.awardNumber,
    programType: "Grant",
  };
}
