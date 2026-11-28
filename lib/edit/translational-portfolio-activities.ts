/**
 * Report 26's grants and clinical trials (plan
 * 2026-11-27-translational-portfolio-redesign-plan.md, PRs 4–5): counts and
 * lists. Trials carry a stage from their phase (`trialStageFromPhaseKey`);
 * grants have none yet (PR 6). Shared by the report (`translational-portfolio-report.ts`)
 * and the one-scholar page (`translational-portfolio-scholar.ts`), so the two
 * count the same awards and trials. Rules decided with Paul on 2026-11-28:
 *
 * Grants
 *   - Leadership roles only: PI, Co-PI, PI-Subaward (`AREA_GRANT_ROLES`, the
 *     research-area pipeline's rule, as first or senior author is for papers).
 *   - Funding awards only: program type Grant, Career or Contract with funding,
 *     and not an agreement intake (material transfer, data use, confidentiality,
 *     consulting, service). InfoEd and RePORTER rows both count, as on the profile.
 *   - #160-suppressed rows are dropped (a suppression marks a wrong record). The
 *     profile's hide-section preference is not applied: this is an /edit report.
 *   - One award counts once, however many WCM investigators hold it: rows are
 *     grouped into funding projects with `groupGrantsByProject`, the key the
 *     Funding search tab, the unit pages and the topic feed use (NIH core project
 *     number, else the InfoEd account). Renewal years collapse into one project.
 *   - A project counts in every calendar year one of its rows was active.
 *
 * Clinical trials
 *   - The scholar is the trial's Principal Investigator (every link in prod is).
 *   - Statuses the profile hides (withdrawn, suspended) are dropped.
 *   - One trial counts once: grouped by NCT number, else protocol number.
 *   - A trial counts in every year it was active: from its CT.gov start (else
 *     the institutional open-to-accrual date, `trialDates`; else the status
 *     date) to its primary completion (else the status date once the study has
 *     closed; else this year, still running).
 *
 * Both: the unit and institution filters are report 8's who-filter
 * (`personFilterSql`) on the investigator, so a cross-department award counts
 * once in each department holding a row on it. A research area is the
 * ReciterAI area score of the grant or trial text (`area_text_key` →
 * `area_signal_topic`, the 0.3 floor), which exists only for leadership-role
 * InfoEd grants and NCT trials started 2020 or later, so under an area filter
 * the older ones drop out (the page says so).
 *
 * Server-only (`@/lib/db`).
 */
import { loadEntitySuppressions } from "@/lib/api/manual-layer";
import { TOPIC_ACTIVITY_SCORE_FLOOR } from "@/lib/api/topic-activity";
import { AREA_GRANT_ROLES, AREA_SIGNAL_GRANT_EXCLUDED_TOPICS, AREA_TRIAL_PI_ROLE } from "@/lib/area-signals";
import { isHiddenTrialStatus } from "@/lib/clinical-trial-status";
import { db } from "@/lib/db";
import { phaseKey, phaseLabel } from "@/lib/edit/clinical-trials-report";
import { currentCenterMembershipSql, MANUAL_DIVISION_SOURCE, personFilterSql, utcToday } from "@/lib/edit/person-filter";
import { groupGrantsByProject } from "@/lib/funding-projection";
import { Prisma } from "@/lib/generated/prisma/client";
import { trialDates } from "@/lib/search-trial-evidence";
import { emptyCounts, trialStageFromPhaseKey, type StageCounts, type TranslationalStage } from "@/lib/translational-stage";

export const GRANT_PROGRAM_TYPES: readonly string[] = ["Grant", "Career", "Contract with funding"];
/** InfoEd intake types that are agreements, not funding. Substrings, so a new
 *  variant of one ("Outgoing Material Transfer Agreement") is dropped too. */
const NON_FUNDING_INTAKE = /material transfer|data use|confidential|consulting|service agreement/i;

export const GRANT_RULE =
  "Grants: awards where the scholar is PI, Co-PI or subaward PI; program type Grant, Career or Contract with funding, not agreements (material transfer, data use, confidentiality, consulting, service). An award counts once however many WCM investigators hold it (renewal years are one award) and counts in every year it was active.";
export const TRIAL_RULE =
  "Clinical trials: studies where the scholar is the principal investigator, not withdrawn or suspended. A trial counts once and counts in every year from its start to its primary completion (still running: to this year). Its stage comes from its phase.";
export const ACTIVITY_AREA_RULE =
  "Under a research area filter, only grants and trials with a research area count: leadership-role grants and registered trials started 2020 or later.";

/** The filters grants and trials honor; the stage pick does not apply (no stages yet). */
export type ActivityScope = {
  from: number;
  to: number;
  /** Person types (`role_category`); none or absent = everyone. */
  types?: string[];
  units: string[];
  insts: string[];
  areas: string[];
  /** One scholar (their page). */
  cwid?: string | null;
};

export type PortfolioPerson = { cwid: string; role: string };

export type PortfolioGrant = {
  key: string;
  title: string;
  funder: string;
  awardNumber: string | null;
  /** The project's whole period, "YYYY-MM-DD" (earliest start, latest end). */
  start: string;
  end: string;
  /** Calendar years inside the window the project was active, ascending. */
  years: number[];
  /** One per investigator row in scope (a person may hold several rows). */
  people: PortfolioPerson[];
  deptCodes: string[];
  areas: string[];
};

export type PortfolioTrial = {
  key: string;
  protocolNumber: string;
  nct: string | null;
  title: string;
  /** "Phase 2", "Phase 1/2", "Not applicable"; null when none is recorded. */
  trialPhase: string | null;
  /** From the trial phase; null = no stage. */
  stage: TranslationalStage | null;
  status: string | null;
  startYear: number;
  /** Null while still running. */
  endYear: number | null;
  years: number[];
  people: PortfolioPerson[];
  deptCodes: string[];
  areas: string[];
};

/** Calendar years `start..end` clipped to `from..to`. */
export function yearsActive(start: number, end: number, from: number, to: number): number[] {
  const out: number[] = [];
  for (let y = Math.max(start, from); y <= Math.min(end, to); y++) out.push(y);
  return out;
}

const yearOf = (d: unknown): number | null => {
  if (d instanceof Date) return d.getUTCFullYear();
  const m = typeof d === "string" ? /^(\d{4})/.exec(d) : null;
  return m ? Number(m[1]) : null;
};
const isoDay = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "").slice(0, 10));

/** A study the institution has closed, or CT.gov calls finished. */
const hasEnded = (status: string | null, ctgov: string | null) =>
  /closure/i.test(status ?? "") || /^(COMPLETED|TERMINATED)$/.test(ctgov ?? "");

export type TrialDateFields = {
  startDate: string | null;
  startDateType: string | null;
  primaryCompletionDate: string | null;
  primaryCompletionDateType: string | null;
  firstOtaDate: Date | null;
  statusDate: Date | null;
  status: string | null;
  ctgovStatus: string | null;
};

/** A trial's first and last active year (module comment); null when nothing dates it. */
export function trialSpan(t: TrialDateFields): { startYear: number; endYear: number | null } | null {
  const d = trialDates(t);
  const statusYear = yearOf(t.statusDate);
  const startYear = d.startYear ?? statusYear;
  if (startYear === null) return null;
  const endYear = yearOf(d.endDate) ?? (hasEnded(t.status, t.ctgovStatus) ? statusYear : null);
  return { startYear, endYear: endYear === null ? null : Math.max(startYear, endYear) };
}

/** "Phase 2", "Phase 1/2", "Early phase 1", "Not applicable"; null when unrecorded. */
export function trialPhaseLabel(phase: string | null): string | null {
  const k = phaseKey(phase);
  return k === "nr" ? null : phaseLabel(k);
}

/** The research areas of each text key, at or over the floor. */
async function loadTextAreas(keys: string[]): Promise<Map<string, string[]>> {
  if (keys.length === 0) return new Map();
  const rows = await db.read.areaSignalTopic.findMany({
    where: { textKey: { in: [...new Set(keys)] }, score: { gte: TOPIC_ACTIVITY_SCORE_FLOOR } },
    select: { textKey: true, parentTopicId: true },
  });
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.textKey, [...(out.get(r.textKey) ?? []), r.parentTopicId]);
  return out;
}

/** The who-filter on the investigator's `scholar s` row. */
function whoSql(s: ActivityScope): Prisma.Sql {
  return Prisma.sql`${personFilterSql({ types: s.types ?? [], unitValues: s.units }, { scholar: "s" })} ${
    s.insts.length > 0 ? personFilterSql({ types: [], unitValues: s.insts.map((c) => `inst:${c}`) }, { scholar: "s" }) : Prisma.empty
  }`;
}

const inAreas = (areas: readonly string[], picked: readonly string[]) =>
  picked.length === 0 || areas.some((a) => picked.includes(a));

type GrantRaw = {
  id: string;
  cwid: string;
  title: string;
  role: string;
  funder: string;
  award_number: string | null;
  external_id: string | null;
  intake_type: string | null;
  start_date: unknown;
  end_date: unknown;
  area_text_key: string | null;
  dc: string | null;
};

export async function loadPortfolioGrants(s: ActivityScope): Promise<PortfolioGrant[]> {
  const raw = await db.read.$queryRaw<GrantRaw[]>(Prisma.sql`
    SELECT g.id, g.cwid, g.title, g.role, g.funder, g.award_number, g.external_id, g.intake_type,
           g.start_date, g.end_date, g.area_text_key, s.dept_code AS dc
      FROM \`grant\` g
      JOIN scholar s ON s.cwid = g.cwid
     WHERE s.deleted_at IS NULL AND s.status = 'active'
       AND g.role IN (${Prisma.join([...AREA_GRANT_ROLES])})
       AND g.program_type IN (${Prisma.join([...GRANT_PROGRAM_TYPES])})
       AND YEAR(g.start_date) <= ${s.to} AND YEAR(g.end_date) >= ${s.from}
       ${whoSql(s)}
       ${s.cwid ? Prisma.sql`AND g.cwid = ${s.cwid}` : Prisma.empty}`);
  const rows = raw.filter((r) => r.external_id && !NON_FUNDING_INTAKE.test(r.intake_type ?? ""));
  if (rows.length === 0) return [];
  const [suppressed, textAreas] = await Promise.all([
    loadEntitySuppressions("grant", rows.map((r) => r.external_id as string), db.read),
    loadTextAreas(rows.flatMap((r) => (r.area_text_key ? [r.area_text_key] : []))),
  ]);
  const projects = groupGrantsByProject(
    rows.map((r) => ({ ...r, externalId: r.external_id, awardNumber: r.award_number })),
    suppressed,
  );
  const out: PortfolioGrant[] = [];
  for (const [key, group] of projects) {
    const areas = [
      ...new Set(group.flatMap((r) => (r.area_text_key ? (textAreas.get(r.area_text_key) ?? []) : []))),
    ].filter((a) => !AREA_SIGNAL_GRANT_EXCLUDED_TOPICS.has(a));
    // ponytail: a project's areas pool every investigator's rows, while one scholar's page sees only
    // theirs; under an area filter the two can disagree when co-PI rows carry different text keys (rare:
    // multi-PI rows share one). Per-person areas if it shows up.
    if (!inAreas(areas, s.areas)) continue;
    const years = [
      ...new Set(group.flatMap((r) => yearsActive(yearOf(r.start_date) ?? 0, yearOf(r.end_date) ?? 0, s.from, s.to))),
    ].sort((a, b) => a - b);
    if (years.length === 0) continue;
    // The newest row names the project (titles drift across renewals).
    const lead = [...group].sort((a, b) => isoDay(b.start_date).localeCompare(isoDay(a.start_date)))[0];
    out.push({
      key,
      title: lead.title,
      funder: lead.funder,
      awardNumber: lead.award_number,
      start: group.map((r) => isoDay(r.start_date)).sort()[0],
      end: group.map((r) => isoDay(r.end_date)).sort().at(-1)!,
      years,
      people: group.map((r) => ({ cwid: r.cwid, role: r.role })),
      deptCodes: [...new Set(group.flatMap((r) => (r.dc ? [r.dc] : [])))],
      areas,
    });
  }
  return out.sort((a, b) => b.start.localeCompare(a.start) || a.key.localeCompare(b.key));
}

type TrialRaw = {
  protocol_number: string;
  nct_number: string | null;
  title: string;
  phase: string | null;
  status: string | null;
  status_date: Date | null;
  ctgov_status: string | null;
  start_date: string | null;
  start_date_type: string | null;
  primary_completion_date: string | null;
  primary_completion_date_type: string | null;
  first_ota_date: Date | null;
  area_text_key: string | null;
  cwid: string;
  role: string;
  dc: string | null;
};

export async function loadPortfolioTrials(s: ActivityScope, now = new Date()): Promise<PortfolioTrial[]> {
  const raw = await db.read.$queryRaw<TrialRaw[]>(Prisma.sql`
    SELECT t.protocol_number, t.nct_number, t.title, t.phase, t.status, t.status_date, t.ctgov_status,
           t.start_date, t.start_date_type, t.primary_completion_date, t.primary_completion_date_type,
           t.first_ota_date, t.area_text_key, pct.cwid, pct.role, s.dept_code AS dc
      FROM person_clinical_trial pct
      JOIN scholar s ON s.cwid = pct.cwid
      JOIN clinical_trial t ON t.protocol_number = pct.protocol_number
     WHERE s.deleted_at IS NULL AND s.status = 'active'
       AND pct.role = ${AREA_TRIAL_PI_ROLE}
       ${whoSql(s)}
       ${s.cwid ? Prisma.sql`AND pct.cwid = ${s.cwid}` : Prisma.empty}`);
  const rows = raw.filter((r) => r.protocol_number && !isHiddenTrialStatus(r.status));
  if (rows.length === 0) return [];
  const textAreas = await loadTextAreas(rows.flatMap((r) => (r.area_text_key ? [r.area_text_key] : [])));
  const byKey = new Map<string, TrialRaw[]>();
  for (const r of rows) {
    const k = r.nct_number?.trim() || r.protocol_number;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const thisYear = now.getUTCFullYear();
  const out: PortfolioTrial[] = [];
  for (const [key, group] of byKey) {
    const t = group[0];
    const span = trialSpan({
      startDate: t.start_date,
      startDateType: t.start_date_type,
      primaryCompletionDate: t.primary_completion_date,
      primaryCompletionDateType: t.primary_completion_date_type,
      firstOtaDate: t.first_ota_date,
      statusDate: t.status_date,
      status: t.status,
      ctgovStatus: t.ctgov_status,
    });
    if (!span) continue;
    const years = yearsActive(span.startYear, span.endYear ?? thisYear, s.from, s.to);
    const areas = [...new Set(group.flatMap((r) => (r.area_text_key ? (textAreas.get(r.area_text_key) ?? []) : [])))];
    if (years.length === 0 || !inAreas(areas, s.areas)) continue;
    // One person row per scholar (protocol rows sharing an NCT repeat them).
    const people = [...new Map(group.map((r) => [r.cwid, { cwid: r.cwid, role: r.role }])).values()];
    out.push({
      key,
      protocolNumber: t.protocol_number,
      nct: t.nct_number?.trim() || null,
      title: t.title,
      trialPhase: trialPhaseLabel(t.phase),
      stage: trialStageFromPhaseKey(phaseKey(t.phase)),
      status: t.status,
      startYear: span.startYear,
      endYear: span.endYear,
      years,
      people,
      deptCodes: [...new Set(group.flatMap((r) => (r.dc ? [r.dc] : [])))],
      areas,
    });
  }
  return out.sort((a, b) => b.startYear - a.startYear || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Tallies (pure).
// ---------------------------------------------------------------------------

type Item = { years: number[]; people: PortfolioPerson[]; deptCodes: string[]; areas: string[] };

/** Items per key, each item once per key it has. */
export function tally<T>(items: readonly T[], keysOf: (item: T) => Iterable<string | number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) for (const k of new Set(keysOf(it))) out.set(String(k), (out.get(String(k)) ?? 0) + 1);
  return out;
}

/** Stage counts per key, each item once per key it has. */
export function stageTally<T extends { stage: TranslationalStage | null }>(
  items: readonly T[],
  keysOf: (item: T) => Iterable<string | number>,
): Map<string, StageCounts> {
  const out = new Map<string, StageCounts>();
  for (const it of items)
    for (const k of new Set([...keysOf(it)].map(String))) {
      const c = out.get(k) ?? emptyCounts();
      c[it.stage ?? "none"] += 1;
      out.set(k, c);
    }
  return out;
}

/** One stage count over all the items. */
export const stageCountsOfItems = <T extends { stage: TranslationalStage | null }>(items: readonly T[]): StageCounts =>
  stageTally(items, () => ["all"]).get("all") ?? emptyCounts();

export type UnitGrouping = "dept" | "div" | "center" | "area";

/** The table grouping's keys for an item: department and research area off the
 *  item, division and center off the investigators' memberships. */
export function unitKeys(item: Item, by: UnitGrouping, memberships: ReadonlyMap<string, readonly string[]>): string[] {
  if (by === "dept") return item.deptCodes;
  if (by === "area") return item.areas;
  return item.people.flatMap((p) => memberships.get(p.cwid) ?? []);
}

export const peopleOf = (item: Item) => item.people.map((p) => p.cwid);

/** Division or center memberships for the given scholars, by report 8's unit
 *  rule (`groupSql` in the report: a division's hand-added members, current
 *  center members). */
export async function loadUnitMemberships(by: "div" | "center", cwids: readonly string[]): Promise<Map<string, string[]>> {
  if (cwids.length === 0) return new Map();
  const list = Prisma.join([...new Set(cwids)]);
  const rows =
    by === "div"
      ? await db.read.$queryRaw<{ cwid: string; g: string }[]>(Prisma.sql`
          SELECT cwid, div_code AS g FROM scholar WHERE div_code IS NOT NULL AND cwid IN (${list})
          UNION
          SELECT dm.cwid, dm.division_code FROM division_membership dm
            JOIN division d ON d.code = dm.division_code
           WHERE d.source = ${Prisma.raw(`'${MANUAL_DIVISION_SOURCE}'`)} AND dm.cwid IN (${list})`)
      : await db.read.$queryRaw<{ cwid: string; g: string }[]>(Prisma.sql`
          SELECT cm.cwid, cm.center_code AS g FROM center_membership cm
           WHERE cm.cwid IN (${list}) AND ${currentCenterMembershipSql("cm", utcToday())}`);
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.cwid, [...(out.get(r.cwid) ?? []), r.g]);
  return out;
}
