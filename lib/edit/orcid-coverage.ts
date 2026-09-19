/**
 * `/edit/orcid-coverage` — ORCID iD and eRA-profile coverage by person type
 * and by department, over active scholars. Aggregates only; never a per-person
 * list (`SCHOLAR_EXPORT_CAP` in `lib/api/export-scholars.ts` is policy).
 *
 * Definitions, because the copy on the page repeats them:
 *  - "ORCID iD on file" = `scholar.orcid` is set. The ONLY source is the WCM
 *    Identity table (#2675/#2676), so a scholar can hold an ORCID the feed
 *    doesn't know about. Never NULLed on absence — Identity may lag ED.
 *  - "eRA profile" = a preferred `person_nih_profile` row: the RePORTER-
 *    resolved NIH person key. A proxy for an eRA Commons account, not proof
 *    (a Commons account with no funded award never reaches RePORTER), and
 *    ~half are name-matched (#2651). The eRA Commons *username* has no source
 *    in SPS at all and is deliberately not a column here.
 *  - "NIH-funded" = any `grant` row for the cwid with `nih_ic` set (`nihIc` is
 *    populated only for NIH awards); "current" additionally needs an award
 *    whose `end_date` is today or later.
 *
 * Three flat reads + one pure fold (`buildOrcidCoverage`), so the fold is
 * testable on a fixture with no DB. ~11k scholar rows; no cache.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import { formatRoleCategory } from "@/lib/role-display";

export const NIH_FILTERS = ["all", "ever", "current", "none"] as const;
export type NihFilter = (typeof NIH_FILTERS)[number];

export const NIH_FILTER_LABELS: Record<NihFilter, string> = {
  all: "Everyone",
  ever: "NIH-funded (any award on file)",
  current: "NIH-funded (award ending today or later)",
  none: "No NIH award on file",
};

/** The department table's default population — the outreach list NIH's
 *  ORCID-for-SciENcv rule is about. The person-type table ignores `role`
 *  (it IS the role breakdown). */
export const DEFAULT_ROLE = "full_time_faculty";

export type OrcidCoverageParams = {
  /** `scholar.role_category` key; null = every person type. */
  role: string | null;
  nih: NihFilter;
  /** `scholar.primary_department`; null = every department. */
  dept: string | null;
};

/** Plain `<select>` values straight off the query string; an unknown `nih`
 *  falls back to `all`, an unknown role/dept just matches nothing (they are
 *  JS-side equality filters, never SQL). */
export function parseOrcidCoverageParams(
  raw: Record<string, string | string[] | undefined> | URLSearchParams,
): OrcidCoverageParams {
  const get = (k: string) => {
    const v = raw instanceof URLSearchParams ? raw.get(k) : raw[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s?.trim() || undefined;
  };
  const role = get("role");
  const nih = get("nih") ?? "all";
  const dept = get("dept");
  return {
    role: role === undefined ? DEFAULT_ROLE : role === "all" ? null : role,
    nih: (NIH_FILTERS as readonly string[]).includes(nih) ? (nih as NihFilter) : "all",
    dept: dept === undefined || dept === "all" ? null : dept,
  };
}

/** `""` or `?role=…&nih=…&dept=…` — the page and its CSV route share it. A
 *  `role` of null spells `role=all` (absent means the default). */
export function orcidCoverageQuery(params: Partial<OrcidCoverageParams>): string {
  const q = new URLSearchParams();
  if (params.role !== undefined) q.set("role", params.role ?? "all");
  if (params.nih !== undefined && params.nih !== "all") q.set("nih", params.nih);
  if (params.dept) q.set("dept", params.dept);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export type ScholarRow = {
  cwid: string;
  roleCategory: string | null;
  primaryDepartment: string | null;
  orcid: string | null;
};
/** One row per NIH-funded cwid; `latestEnd` = MAX(grant.end_date) among its NIH awards. */
export type NihRow = { cwid: string; latestEnd: Date | null };

export type CoverageCounts = {
  people: number;
  /** ORCID iD on file. */
  orcid: number;
  /** Preferred eRA profile_id on file. */
  era: number;
  both: number;
  nihPeople: number;
  nihOrcid: number;
  /** NIH-funded AND a preferred eRA profile. The gap (nihPeople - nihEra) is as
   *  much a resolver miss (#2651) as a missing Commons account. */
  nihEra: number;
};
export type CoverageRow = CoverageCounts & { key: string | null; label: string };

export type OrcidCoverage = {
  params: OrcidCoverageParams;
  /** Always the unfiltered population — the three numbers anyone asks for. */
  tiles: { overall: CoverageCounts; fullTime: CoverageCounts; nihFullTime: CoverageCounts };
  /** Filtered by `nih` + `dept`; every person type; people desc. */
  byRole: CoverageRow[];
  /** Filtered by `role` + `nih`; NIH-funded-without-ORCID desc (the action list). */
  byDept: CoverageRow[];
  /** Select choices from the data: [key, label] by headcount desc; departments A–Z. */
  roles: Array<[string, string]>;
  depts: string[];
};

export const neither = (c: CoverageCounts) => c.people - c.orcid - c.era + c.both;
export const nihNoOrcid = (c: CoverageCounts) => c.nihPeople - c.nihOrcid;
export const nihNoEra = (c: CoverageCounts) => c.nihPeople - c.nihEra;
export const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);

const roleLabel = (key: string | null) => formatRoleCategory(key) ?? "Unclassified";

export function buildOrcidCoverage(
  scholars: ScholarRow[],
  nih: NihRow[],
  eraCwids: Iterable<string>,
  params: OrcidCoverageParams,
  today: Date,
): OrcidCoverage {
  const nihEnd = new Map(nih.map((r) => [r.cwid, r.latestEnd]));
  const era = new Set(eraCwids);
  const isNih = (s: ScholarRow) => nihEnd.has(s.cwid);
  const isCurrent = (s: ScholarRow) => {
    const end = nihEnd.get(s.cwid);
    return end != null && end.getTime() >= today.getTime();
  };
  const nihOk = (s: ScholarRow) =>
    params.nih === "all"
      ? true
      : params.nih === "ever"
        ? isNih(s)
        : params.nih === "current"
          ? isCurrent(s)
          : !isNih(s);

  const count = (rows: ScholarRow[]): CoverageCounts => {
    const c = { people: 0, orcid: 0, era: 0, both: 0, nihPeople: 0, nihOrcid: 0, nihEra: 0 };
    for (const s of rows) {
      const o = s.orcid !== null;
      const e = era.has(s.cwid);
      c.people++;
      if (o) c.orcid++;
      if (e) c.era++;
      if (o && e) c.both++;
      if (isNih(s)) {
        c.nihPeople++;
        if (o) c.nihOrcid++;
        if (e) c.nihEra++;
      }
    }
    return c;
  };
  const group = (rows: ScholarRow[], key: (s: ScholarRow) => string | null, label: (k: string | null) => string) => {
    const buckets = new Map<string | null, ScholarRow[]>();
    for (const s of rows) {
      const k = key(s);
      const b = buckets.get(k);
      if (b) b.push(s);
      else buckets.set(k, [s]);
    }
    return [...buckets].map(([k, b]) => ({ key: k, label: label(k), ...count(b) }));
  };

  const fullTime = scholars.filter((s) => s.roleCategory === DEFAULT_ROLE);
  const nihFiltered = scholars.filter(nihOk);

  const byRole = group(
    nihFiltered.filter((s) => params.dept === null || s.primaryDepartment === params.dept),
    (s) => s.roleCategory,
    roleLabel,
  ).sort((a, b) => b.people - a.people || a.label.localeCompare(b.label));
  const byDept = group(
    nihFiltered.filter((s) => params.role === null || s.roleCategory === params.role),
    (s) => s.primaryDepartment,
    (k) => k ?? "No department",
  ).sort((a, b) => nihNoOrcid(b) - nihNoOrcid(a) || b.people - a.people || a.label.localeCompare(b.label));

  const roles = group(scholars, (s) => s.roleCategory, roleLabel)
    .sort((a, b) => b.people - a.people || a.label.localeCompare(b.label))
    .filter((r): r is CoverageRow & { key: string } => r.key !== null)
    .map((r) => [r.key, r.label] as [string, string]);
  const depts = [...new Set(scholars.map((s) => s.primaryDepartment))]
    .filter((d): d is string => d !== null)
    .sort((a, b) => a.localeCompare(b));

  return {
    params,
    tiles: { overall: count(scholars), fullTime: count(fullTime), nihFullTime: count(fullTime.filter(isNih)) },
    byRole,
    byDept,
    roles,
    depts,
  };
}

export type OrcidCoverageClient = Pick<PrismaClient, "scholar" | "grant" | "personNihProfile">;

export async function loadOrcidCoverage(
  db: OrcidCoverageClient,
  params: OrcidCoverageParams,
): Promise<OrcidCoverage> {
  const [scholars, nih, era] = await Promise.all([
    // Same population the Identity ETL writes to (`etl/identity/index.ts`),
    // narrowed to status=active like every other console aggregate.
    db.scholar.findMany({
      where: { deletedAt: null, status: "active" },
      select: { cwid: true, roleCategory: true, primaryDepartment: true, orcid: true },
    }),
    db.grant.groupBy({ by: ["cwid"], where: { nihIc: { not: null } }, _max: { endDate: true } }),
    db.personNihProfile.findMany({ where: { isPreferred: true }, select: { cwid: true } }),
  ]);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return buildOrcidCoverage(
    scholars,
    nih.map((r) => ({ cwid: r.cwid, latestEnd: r._max.endDate })),
    era.map((r) => r.cwid),
    params,
    today,
  );
}

export const CSV_HEADERS = [
  "Department",
  "People",
  "ORCID iD on file",
  "ORCID %",
  "eRA profile on file",
  "Both",
  "Neither",
  "NIH-funded",
  "NIH-funded with ORCID",
  "NIH-funded without ORCID",
  "NIH-funded without eRA profile",
] as const;

/** The department table as CSV — aggregates only, no per-person rows. */
export function orcidCoverageCsv(rows: CoverageRow[]): string {
  return toCsv(
    CSV_HEADERS,
    rows.map((r) => [
      r.label,
      r.people,
      r.orcid,
      r.people === 0 ? "" : ((100 * r.orcid) / r.people).toFixed(1),
      r.era,
      r.both,
      neither(r),
      r.nihPeople,
      r.nihOrcid,
      nihNoOrcid(r),
      nihNoEra(r),
    ]),
  );
}
