/**
 * Department / division faculty CSV export (extends #1102 to org units without a
 * curated roster).
 *
 * Centers export their manually-curated `CenterMembership` roster (membership
 * type / program / dates) via `unit-roster-export.ts`. Departments and divisions
 * have NO such curated roster — their members are the ED-derived faculty shown on
 * the public unit page. This module exports THAT member set, with faculty-shaped
 * columns (no membership type / program / dates — those are center-only; no email
 * per the #847 no-contact-column decision).
 *
 * Member set, by unit type (mirrors the public page exactly):
 *   - department → active scholars with `deptCode = <code>`.
 *   - division   → active scholars with `divCode = <code>`, UNIONed with the
 *     `DivisionMembership` roster when the division is `source = 'manual'` (#540
 *     Phase 8 — the same union `loadDivisionMemberCwids` / `getDivisionFaculty`
 *     apply), then filtered back through `Scholar` (active, non-deleted).
 *
 * The export is gated by the SAME flag as the center roster export
 * (`EDIT_UNIT_ROSTER_EXPORT`, `isUnitRosterExportEnabled`) and the SAME authz
 * boundary (the route re-derives the actor's role on the unit via
 * `loadUnitEditContext` before calling any loader here).
 *
 * GUARDRAIL: membership is sourced ONLY from Prisma (`Scholar` /
 * `DivisionMembership`), NEVER the search index — no browse-facet key is read.
 */
import { toCsv, type CsvCell } from "@/lib/csv";

/** The faculty-export columns. Distinct from `ROSTER_CSV_HEADERS` (center). */
export const FACULTY_CSV_HEADERS = [
  "cwid",
  "name",
  "title",
  "role_category",
  "division",
  "department",
] as const;

/** One exportable faculty member. */
export type FacultyExportRow = {
  cwid: string;
  preferredName: string;
  primaryTitle: string | null;
  roleCategory: string | null;
  divisionName: string | null;
  departmentName: string | null;
};

/** The narrow Prisma surface these loaders read — `db.read` satisfies it
 *  structurally, and the route/unit tests can mock exactly these models. */
export type FacultyExportClient = {
  scholar: {
    findMany(args: unknown): Promise<
      Array<{
        cwid: string;
        preferredName: string;
        primaryTitle: string | null;
        roleCategory: string | null;
        department: { name: string } | null;
        division: { name: string } | null;
      }>
    >;
    count(args: unknown): Promise<number>;
  };
  divisionMembership: {
    findMany(args: unknown): Promise<Array<{ cwid: string }>>;
  };
};

const FACULTY_SELECT = {
  cwid: true,
  preferredName: true,
  primaryTitle: true,
  roleCategory: true,
  department: { select: { name: true } },
  division: { select: { name: true } },
} as const;

function toRows(
  rows: Awaited<ReturnType<FacultyExportClient["scholar"]["findMany"]>>,
): FacultyExportRow[] {
  return rows.map((r) => ({
    cwid: r.cwid,
    preferredName: r.preferredName,
    primaryTitle: r.primaryTitle,
    roleCategory: r.roleCategory,
    divisionName: r.division?.name ?? null,
    departmentName: r.department?.name ?? null,
  }));
}

/** Active faculty of a department (ED-derived; departments have no manual roster). */
export async function loadDepartmentRosterForExport(
  client: FacultyExportClient,
  deptCode: string,
): Promise<FacultyExportRow[]> {
  const rows = await client.scholar.findMany({
    where: { deptCode, deletedAt: null, status: "active" },
    select: FACULTY_SELECT,
    orderBy: { preferredName: "asc" },
  });
  return toRows(rows);
}

/**
 * The member CWIDs of a division: LDAP-attached scholars (`divCode = code`) plus,
 * for a `source = 'manual'` division, the `DivisionMembership` roster. Deduped;
 * the caller's `Scholar` fetch re-filters to active/non-deleted, so a manual
 * member who isn't a displayable scholar drops out (matching the public page).
 */
async function divisionMemberCwids(
  client: FacultyExportClient,
  divCode: string,
  source: string,
): Promise<string[]> {
  const ldap = await client.scholar.findMany({
    where: { divCode, deletedAt: null, status: "active" },
    select: { cwid: true },
  });
  const ldapCwids = (ldap as Array<{ cwid: string }>).map((r) => r.cwid);
  if (source !== "manual") return ldapCwids;
  const manual = await client.divisionMembership.findMany({
    where: { divisionCode: divCode },
    select: { cwid: true },
  });
  return [...new Set([...ldapCwids, ...manual.map((r) => r.cwid)])];
}

/** Active faculty of a division (ED + manual roster union). */
export async function loadDivisionRosterForExport(
  client: FacultyExportClient,
  divCode: string,
  source: string,
): Promise<FacultyExportRow[]> {
  const cwids = await divisionMemberCwids(client, divCode, source);
  if (cwids.length === 0) return [];
  const rows = await client.scholar.findMany({
    where: { cwid: { in: cwids }, deletedAt: null, status: "active" },
    select: FACULTY_SELECT,
    orderBy: { preferredName: "asc" },
  });
  return toRows(rows);
}

/** Count of a department's active faculty (for the Members-tab header). */
export async function countDepartmentRoster(
  client: FacultyExportClient,
  deptCode: string,
): Promise<number> {
  return client.scholar.count({ where: { deptCode, deletedAt: null, status: "active" } });
}

/** Count of a division's members (ED + manual union, filtered to active scholars). */
export async function countDivisionRoster(
  client: FacultyExportClient,
  divCode: string,
  source: string,
): Promise<number> {
  const cwids = await divisionMemberCwids(client, divCode, source);
  if (cwids.length === 0) return 0;
  return client.scholar.count({
    where: { cwid: { in: cwids }, deletedAt: null, status: "active" },
  });
}

/** Serialize faculty rows to CSV (`FACULTY_CSV_HEADERS`). */
export function buildFacultyCsv(rows: ReadonlyArray<FacultyExportRow>): string {
  const body: CsvCell[][] = rows.map((r) => [
    r.cwid,
    r.preferredName,
    r.primaryTitle,
    r.roleCategory,
    r.divisionName,
    r.departmentName,
  ]);
  return toCsv(FACULTY_CSV_HEADERS, body);
}
