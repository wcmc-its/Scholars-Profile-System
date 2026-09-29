/**
 * Report 11 — "Core users" (core-only). The WCM authors of this core's
 * confirmed publications, one row per person: name, department, person type,
 * how many of the core's confirmed papers they are on, their first and last
 * year, and whether the core lists them as a known client (`core_client`,
 * active = `removed_at IS NULL`). A Departments tab rolls the people up.
 *
 * Who counts: a `publication_author` row with a CWID (a WCM author) that
 * ReCiter has confirmed (`is_confirmed`, the same author rule report 3 keys a
 * core's Person-type rail on), whose scholar row is not deleted. Suppressed or
 * departed scholars still count — a core's history of users does not shrink
 * when someone leaves. The paper set is the core's confirmed set
 * (`loadCoreConfirmedPmids`).
 *
 * Filters (URL, every param optional, junk falls back to the default):
 *   - `type`, `unit` — the reserved who-filter (`parsePersonFilter` +
 *     `personFilterSql`, `lib/edit/person-filter.ts`); the rail offers the
 *     person types and departments present among this core's users.
 *   - `client` (`any` | `yes` | `no`), `minp` (`0` | `2` | `5`).
 *   - `from` / `to` — publication-year window; a paper outside it does not
 *     count toward anyone. Unset = every year.
 *   - `view` (`people` | `departments`) — a view, not a filter.
 *
 * Export: a list of scholars, so `SCHOLAR_EXPORT_CAP` applies — above it the
 * download is REFUSED whole (the route 409s, the page shows why instead of
 * the button). Never truncated. No email column.
 *
 * Server-only (`@/lib/db`); the builders below the loaders are pure.
 */
import ExcelJS from "exceljs";

import { loadDataQualityFacets } from "@/lib/api/data-quality";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { db } from "@/lib/db";
import { chunk, coreCriteriaHead, parseYear } from "@/lib/edit/core-report-common";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  parsePersonFilter,
  personFilterCriteria,
  personFilterSql,
  unitLabels,
} from "@/lib/edit/person-filter";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";
import { formatRoleCategory } from "@/lib/role-display";

export const CLIENT_LABEL = {
  any: "Any",
  yes: "Known clients",
  no: "Not on the client roster",
} as const;
export type ClientFilter = keyof typeof CLIENT_LABEL;

export const MIN_PAPERS = [0, 2, 5] as const;
export type MinPapers = (typeof MIN_PAPERS)[number];
export const MIN_PAPERS_LABEL: Record<MinPapers, string> = {
  0: "Any",
  2: "2+ papers",
  5: "5+ papers",
};

export type CoreUsersView = "people" | "departments";

export type CoreUsersParams = {
  /** Raw roleCategory values (`type`). */
  types: string[];
  /** Encoded unit values (`unit`), raw so they round-trip. */
  units: string[];
  client: ClientFilter;
  minPapers: MinPapers;
  from: number | null;
  to: number | null;
  view: CoreUsersView;
};

export function parseCoreUsersParams(sp: URLSearchParams): CoreUsersParams {
  const person = parsePersonFilter(sp);
  const client =
    (Object.keys(CLIENT_LABEL) as ClientFilter[]).find((c) => c === sp.get("client")) ?? "any";
  const minRaw = Number(sp.get("minp"));
  const minPapers = MIN_PAPERS.find((m) => m === minRaw) ?? 0;
  let from = parseYear(sp.get("from"));
  let to = parseYear(sp.get("to"));
  if (from !== null && to !== null && from > to) [from, to] = [to, from];
  return {
    types: person.types,
    units: person.unitValues,
    client,
    minPapers,
    from,
    to,
    view: sp.get("view") === "departments" ? "departments" : "people",
  };
}

/** The canonical query string (without the core pair), `view` optional. */
export function coreUsersQuery(p: CoreUsersParams, view: CoreUsersView = p.view): URLSearchParams {
  const q = new URLSearchParams();
  for (const t of p.types) q.append("type", t);
  for (const u of p.units) q.append("unit", u);
  if (p.client !== "any") q.set("client", p.client);
  if (p.minPapers !== 0) q.set("minp", String(p.minPapers));
  if (p.from !== null) q.set("from", String(p.from));
  if (p.to !== null) q.set("to", String(p.to));
  if (view !== "people") q.set("view", view);
  return q;
}

export function isCoreUsersDefault(p: CoreUsersParams): boolean {
  return (
    p.types.length === 0 &&
    p.units.length === 0 &&
    p.client === "any" &&
    p.minPapers === 0 &&
    p.from === null &&
    p.to === null
  );
}

/** One confirmed WCM authorship on one of the core's confirmed papers. */
export type CoreAuthorship = {
  cwid: string;
  name: string;
  deptCode: string | null;
  department: string | null;
  roleCategory: string | null;
  pmid: string;
  year: number | null;
};

export type CoreUserRow = {
  cwid: string;
  name: string;
  deptCode: string | null;
  department: string | null;
  roleCategory: string | null;
  papers: number;
  firstYear: number | null;
  lastYear: number | null;
  knownClient: boolean;
};

export type CoreUserDepartmentRow = { department: string; people: number; papers: number };

export type FacetOption = { value: string; label: string; count: number };

export type CoreUsersResult = {
  people: CoreUserRow[];
  departments: CoreUserDepartmentRow[];
  /** Rail options: person types / departments present among the core's users
   *  in the year window, counted in people (before the who / client / papers
   *  filters, so an option never vanishes as you tick it). */
  typeOptions: FacetOption[];
  deptOptions: FacetOption[];
};

export const NO_DEPARTMENT = "No department on record";

const inWindow = (y: number | null, from: number | null, to: number | null) =>
  (from === null && to === null) ||
  (y !== null && (from === null || y >= from) && (to === null || y <= to));

/**
 * One row per person. Pure. `whoMatch` = the CWIDs the who-filter keeps
 * (`null` = no who-filter set); `clientCwids` = active known clients, LOWERCASED
 * (`loadActiveClientCwids`). The client match is case-insensitive, the same
 * convention as `lib/api/core-clients.ts` and the review queue, because a
 * Scholar row's `cwid` casing is not guaranteed to match `core_client.cwid`.
 * A person counts each distinct PMID once however many authorship rows repeat it.
 */
export function buildCoreUsers(
  authorships: readonly CoreAuthorship[],
  opts: {
    whoMatch: ReadonlySet<string> | null;
    clientCwids: ReadonlySet<string>;
    params: Pick<CoreUsersParams, "client" | "minPapers" | "from" | "to">;
  },
): CoreUsersResult {
  const { params } = opts;
  type Acc = Omit<CoreUserRow, "papers" | "knownClient"> & { pmids: Set<string> };
  const byCwid = new Map<string, Acc>();
  for (const a of authorships) {
    if (!inWindow(a.year, params.from, params.to)) continue;
    let acc = byCwid.get(a.cwid);
    if (!acc) {
      acc = {
        cwid: a.cwid,
        name: a.name,
        deptCode: a.deptCode,
        department: a.department,
        roleCategory: a.roleCategory,
        firstYear: null,
        lastYear: null,
        pmids: new Set(),
      };
      byCwid.set(a.cwid, acc);
    }
    acc.pmids.add(a.pmid);
    if (a.year !== null) {
      acc.firstYear = acc.firstYear === null ? a.year : Math.min(acc.firstYear, a.year);
      acc.lastYear = acc.lastYear === null ? a.year : Math.max(acc.lastYear, a.year);
    }
  }
  const all: CoreUserRow[] = [...byCwid.values()].map(({ pmids, ...rest }) => ({
    ...rest,
    papers: pmids.size,
    knownClient: opts.clientCwids.has(rest.cwid.toLowerCase()),
  }));

  const typeCounts = new Map<string, number>();
  const deptCounts = new Map<string, { label: string; count: number }>();
  for (const r of all) {
    if (r.roleCategory) typeCounts.set(r.roleCategory, (typeCounts.get(r.roleCategory) ?? 0) + 1);
    if (r.deptCode) {
      const d = deptCounts.get(r.deptCode) ?? { label: r.department ?? r.deptCode, count: 0 };
      d.count++;
      deptCounts.set(r.deptCode, d);
    }
  }
  const byCount = (a: FacetOption, b: FacetOption) =>
    b.count - a.count || a.label.localeCompare(b.label);
  const typeOptions = [...typeCounts].map(([value, count]) => ({
    value,
    label: formatRoleCategory(value) ?? value,
    count,
  }));
  const deptOptions = [...deptCounts].map(([code, d]) => ({
    value: `dept:${code}`,
    label: d.label,
    count: d.count,
  }));

  const people = all
    .filter((r) => opts.whoMatch === null || opts.whoMatch.has(r.cwid))
    .filter((r) => params.client === "any" || r.knownClient === (params.client === "yes"))
    .filter((r) => r.papers >= params.minPapers)
    .sort((a, b) => b.papers - a.papers || a.name.localeCompare(b.name));

  const depts = new Map<string, CoreUserDepartmentRow>();
  for (const r of people) {
    const label = r.department ?? NO_DEPARTMENT;
    const d = depts.get(label) ?? { department: label, people: 0, papers: 0 };
    d.people++;
    d.papers += r.papers;
    depts.set(label, d);
  }
  return {
    people,
    departments: [...depts.values()].sort(
      (a, b) => b.people - a.people || a.department.localeCompare(b.department),
    ),
    typeOptions: typeOptions.sort(byCount),
    deptOptions: deptOptions.sort(byCount),
  };
}

/** Whether the People download may be offered — the scholar-list cap. A list
 *  over it is refused whole, never cut to fit. */
export function coreUsersExportAllowed(people: number, cap: number = SCHOLAR_EXPORT_CAP): boolean {
  return people <= cap;
}

export function coreUsersOverCapMessage(people: number, cap: number = SCHOLAR_EXPORT_CAP): string {
  return `${people.toLocaleString()} people match. A list of people can only be downloaded for ${cap} or fewer, so there is no download for this selection. Narrow the filters (for example by department or person type) to download it.`;
}

type RawAuthorship = {
  cwid: string;
  pmid: string;
  year: number | null;
  preferred_name: string;
  role_category: string | null;
  dept_code: string | null;
  dept_name: string | null;
  primary_department: string | null;
};

/** Every confirmed WCM authorship on these papers (see the module comment). */
export async function loadCoreAuthorships(pmids: readonly string[]): Promise<CoreAuthorship[]> {
  const out: CoreAuthorship[] = [];
  for (const batch of chunk(pmids)) {
    const rows = await db.read.$queryRaw<RawAuthorship[]>`
      SELECT DISTINCT pa.cwid, pa.pmid, p.year, s.preferred_name, s.role_category, s.dept_code,
             d.name AS dept_name, s.primary_department
        FROM publication_author pa
        JOIN scholar s ON s.cwid = pa.cwid
        JOIN publication p ON p.pmid = pa.pmid
        LEFT JOIN department d ON d.code = s.dept_code
       WHERE pa.pmid IN (${Prisma.join(batch)})
         AND pa.cwid IS NOT NULL
         AND pa.is_confirmed = 1
         AND s.deleted_at IS NULL`;
    for (const r of rows) {
      out.push({
        cwid: r.cwid,
        pmid: r.pmid,
        year: r.year === null ? null : Number(r.year),
        name: r.preferred_name,
        roleCategory: r.role_category,
        deptCode: r.dept_code,
        department: r.dept_name ?? r.primary_department,
      });
    }
  }
  return out;
}

/** The CWIDs among `cwids` the who-filter keeps, or null when none is set. */
export async function loadWhoMatch(
  p: CoreUsersParams,
  cwids: readonly string[],
): Promise<Set<string> | null> {
  if (p.types.length === 0 && p.units.length === 0) return null;
  if (cwids.length === 0) return new Set();
  const out = new Set<string>();
  for (const batch of chunk(cwids)) {
    const rows = await db.read.$queryRaw<{ cwid: string }[]>`
      SELECT s.cwid FROM scholar s
       WHERE s.cwid IN (${Prisma.join(batch)})
       ${personFilterSql({ types: p.types, unitValues: p.units }, { scholar: "s", centerMembership: "cm" })}`;
    for (const r of rows) out.add(r.cwid);
  }
  return out;
}

/** The core's active known clients' CWIDs, LOWERCASED (see `buildCoreUsers`). */
export async function loadActiveClientCwids(coreId: string): Promise<Set<string>> {
  const rows = await db.read.coreClient.findMany({
    where: { coreId, removedAt: null, cwid: { not: null } },
    select: { cwid: true },
  });
  return new Set(rows.map((r) => r.cwid?.toLowerCase()).filter((c): c is string => !!c));
}

/** The page's and the download's ONE loader. */
export async function loadCoreUsersReport(
  coreId: string,
  pmids: readonly string[],
  p: CoreUsersParams,
) {
  const [authorships, clientCwids] = await Promise.all([
    loadCoreAuthorships(pmids),
    loadActiveClientCwids(coreId),
  ]);
  const whoMatch = await loadWhoMatch(p, [...new Set(authorships.map((a) => a.cwid))]);
  return buildCoreUsers(authorships, { whoMatch, clientCwids, params: p });
}

export function yearWindowLabel(p: Pick<CoreUsersParams, "from" | "to">): string {
  if (p.from === null && p.to === null) return "All years";
  if (p.from === null) return `Through ${p.to}`;
  if (p.to === null) return `${p.from} onward`;
  return p.from === p.to ? String(p.from) : `${p.from}–${p.to}`;
}

export async function buildCoreUsersWorkbook(
  coreName: string,
  p: CoreUsersParams,
  r: CoreUsersResult,
  generatedAt: Date,
): Promise<Buffer> {
  const labels =
    p.units.length > 0
      ? unitLabels(await loadDataQualityFacets(db.read))
      : new Map<string, string>();
  const wb = new ExcelJS.Workbook();
  addCriteriaSheet(wb, [
    ...coreCriteriaHead("11. Core users", coreName, generatedAt),
    ...personFilterCriteria(
      { types: p.types, unitValues: p.units },
      labels,
      (t) => formatRoleCategory(t) ?? t,
    ),
    ["Known client", CLIENT_LABEL[p.client]],
    ["Minimum confirmed papers", MIN_PAPERS_LABEL[p.minPapers]],
    ["Publication years", yearWindowLabel(p)],
    [
      "Counting rule",
      "People are ReCiter-confirmed Weill Cornell authors of this core's confirmed publications. A person counts once; their paper count is the distinct confirmed papers they authored, so paper counts add up to more than the core's total.",
    ],
  ]);
  const people = wb.addWorksheet("People");
  people.addRow([
    "Name",
    "CWID",
    "Department",
    "Person type",
    "Confirmed papers",
    "First year",
    "Last year",
    "Known client",
  ]);
  boldRow(people, 1);
  people.views = [{ state: "frozen", ySplit: 1 }];
  for (const u of r.people) {
    people.addRow([
      u.name,
      u.cwid,
      u.department ?? "",
      formatRoleCategory(u.roleCategory) ?? "",
      u.papers,
      u.firstYear,
      u.lastYear,
      u.knownClient ? "Yes" : "No",
    ]);
  }
  for (const [i, w] of [30, 12, 36, 24, 16, 11, 11, 13].entries())
    people.getColumn(i + 1).width = w;
  const depts = wb.addWorksheet("Departments");
  depts.addRow(["Department", "People", "Papers"]);
  boldRow(depts, 1);
  for (const d of r.departments) depts.addRow([d.department, d.people, d.papers]);
  depts.getColumn(1).width = 44;
  return workbookBuffer(wb);
}
