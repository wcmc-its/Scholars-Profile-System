/**
 * Report 23 — Vice Chairs across departments. Answers "who are the Vice Chairs
 * for Research?" in one place: every `unit_leadership_role` row with an active
 * holder, filterable by area, department, site and a name/title search.
 *
 * The table is small (tens of rows per department), so it is read whole and
 * filtered here. View-only: no export.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import {
  LEADERSHIP_FUNCTIONS,
  LEADERSHIP_SITES,
  isFullTimeFaculty,
  leadershipTierRank,
  parseFunctions,
  type LeadershipFunction,
  type LeadershipSite,
} from "@/lib/unit-leadership";

export type ViceChairReportParams = {
  q: string;
  /** A function code, `general` (no area), or `all`. */
  area: LeadershipFunction | "general" | "all";
  /** A department code, or `all`. */
  dept: string;
  /** A site code, `any` (any site-based role), or `all`. */
  site: LeadershipSite | "any" | "all";
};

export function parseViceChairReportParams(
  sp: Record<string, string | string[] | undefined>,
): ViceChairReportParams {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  };
  const area = one("area");
  const site = one("site");
  return {
    q: one("q").slice(0, 100),
    area:
      area === "general" || (LEADERSHIP_FUNCTIONS as readonly string[]).includes(area)
        ? (area as ViceChairReportParams["area"])
        : "all",
    dept: one("dept").slice(0, 64) || "all",
    site:
      site === "any" || (LEADERSHIP_SITES as readonly string[]).includes(site)
        ? (site as ViceChairReportParams["site"])
        : "all",
  };
}

export type ViceChairReportRow = {
  id: string;
  cwid: string;
  name: string;
  departmentCode: string;
  departmentName: string;
  displayTitle: string;
  tier: string;
  functions: LeadershipFunction[];
  areaText: string | null;
  site: LeadershipSite | null;
  fullTimeFaculty: boolean;
};

export type ViceChairReport = {
  /** Every row with an active holder, before filters. */
  total: number;
  people: number;
  /** Departments that list at least one Vice Chair, for the filter. */
  departments: { code: string; name: string; count: number }[];
  rows: ViceChairReportRow[];
};

export async function loadViceChairReport(
  client: Pick<PrismaClient, "unitLeadershipRole" | "department">,
  p: ViceChairReportParams,
): Promise<ViceChairReport> {
  const raw = await client.unitLeadershipRole.findMany({
    where: { entityType: "department" },
    select: {
      id: true,
      cwid: true,
      entityId: true,
      displayTitle: true,
      tier: true,
      functions: true,
      areaText: true,
      site: true,
      scholar: {
        select: {
          preferredName: true,
          primaryTitle: true,
          edPrimaryTitle: true,
          roleCategory: true,
          deletedAt: true,
          status: true,
        },
      },
    },
  });
  const active = raw.filter((r) => r.scholar.deletedAt === null && r.scholar.status === "active");
  const depts = active.length
    ? await client.department.findMany({
        where: { code: { in: [...new Set(active.map((r) => r.entityId))] } },
        select: { code: true, name: true },
      })
    : [];
  const deptName = new Map(depts.map((d) => [d.code, d.name]));

  const all: ViceChairReportRow[] = active.map((r) => ({
    id: r.id,
    cwid: r.cwid,
    name: r.scholar.preferredName,
    departmentCode: r.entityId,
    departmentName: deptName.get(r.entityId) ?? r.entityId,
    displayTitle: r.displayTitle,
    tier: r.tier,
    functions: parseFunctions(r.functions),
    areaText: r.areaText,
    site: r.site as LeadershipSite | null,
    fullTimeFaculty: isFullTimeFaculty(r.scholar.roleCategory, r.scholar.primaryTitle, r.scholar.edPrimaryTitle),
  }));

  const counts = new Map<string, number>();
  for (const r of all) counts.set(r.departmentCode, (counts.get(r.departmentCode) ?? 0) + 1);
  const departments = [...counts]
    .map(([code, count]) => ({ code, name: deptName.get(code) ?? code, count }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const q = p.q.toLowerCase();
  const rows = all
    .filter(
      (r) =>
        (q === "" || r.name.toLowerCase().includes(q) || r.displayTitle.toLowerCase().includes(q)) &&
        (p.area === "all" ||
          (p.area === "general" ? r.functions.length === 0 : r.functions.includes(p.area))) &&
        (p.dept === "all" || r.departmentCode === p.dept) &&
        (p.site === "all" || (p.site === "any" ? r.site !== null : r.site === p.site)),
    )
    .sort(
      (a, b) =>
        a.departmentName.localeCompare(b.departmentName) ||
        leadershipTierRank(a.tier) - leadershipTierRank(b.tier) ||
        a.name.localeCompare(b.name),
    );

  return { total: all.length, people: new Set(all.map((r) => r.cwid)).size, departments, rows };
}
