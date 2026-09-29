/**
 * Report 13 — "Grants citing the core" (core-only). The grants linked to this
 * core's confirmed publications through `grant_publication` (NIH RePORTER +
 * reciterdb links, one row per InfoEd `grant` row), collapsed to ONE row per
 * AWARD: InfoEd keeps a row per person on an award and per renewal, so the
 * award number is normalized to IC + serial (`awardKey`, the rule of the
 * 2026-09-28 grant-signal probe) and every row sharing a key folds together.
 *
 * Per award: the title and PI from the row whose role is `PI` (else the first
 * holder: earliest start, then CWID), the funder (`primeSponsor ?? funder`),
 * the mechanism, the period (min start – max end over ALL of the award's
 * `grant` rows, linked or not, found by the raw award numbers the links
 * carry), Active when the as-of date (UTC today) falls in that period, and the
 * distinct confirmed PMIDs linked to any of its rows.
 *
 * Only NIH grants held by WCM investigators have links (RePORTER + reciterdb
 * are the only sources), so non-NIH funding is effectively absent; the page
 * says so under the headline.
 *
 * URL: `status` (`active` | `any`, default active), repeated `funder` and
 * `mech`, `view` (`grants` | `funders`, a view).
 *
 * Not a scholar list (one row per award, the PI a column), so
 * `SCHOLAR_EXPORT_CAP` does not apply.
 *
 * Server-only (`@/lib/db`); `awardKey` / `collapseAwards` / `filterAwards` are pure.
 */
import ExcelJS from "exceljs";

import { db } from "@/lib/db";
import { chunk, coreCriteriaHead } from "@/lib/edit/core-report-common";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";

export const NON_NIH_NOTE =
  "Only NIH grants held by Weill Cornell investigators can be linked to papers. Other funding won't appear here.";

export const STATUS_LABEL = { active: "Active today", any: "Any time" } as const;
export type GrantStatusFilter = keyof typeof STATUS_LABEL;
export type CoreGrantsView = "grants" | "funders";

export type CoreGrantsParams = {
  status: GrantStatusFilter;
  funders: string[];
  mechs: string[];
  view: CoreGrantsView;
};

const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

export function parseCoreGrantsParams(sp: URLSearchParams): CoreGrantsParams {
  return {
    status: sp.get("status") === "any" ? "any" : "active",
    funders: clean(sp.getAll("funder")),
    mechs: clean(sp.getAll("mech")),
    view: sp.get("view") === "funders" ? "funders" : "grants",
  };
}

export function coreGrantsQuery(
  p: CoreGrantsParams,
  view: CoreGrantsView = p.view,
): URLSearchParams {
  const q = new URLSearchParams();
  if (p.status !== "active") q.set("status", p.status);
  for (const f of p.funders) q.append("funder", f);
  for (const m of p.mechs) q.append("mech", m);
  if (view !== "grants") q.set("view", view);
  return q;
}

export function isCoreGrantsDefault(p: CoreGrantsParams): boolean {
  return p.status === "active" && p.funders.length === 0 && p.mechs.length === 0;
}

/** Award number → a stable key (IC + zero-padded serial), so the per-person
 *  and per-renewal rows of one award collapse: `5R01CA123456-03`,
 *  `R01 CA123456` and `CA-123456` all → `CA123456`. Anything without that
 *  shape keeps its alphanumerics, uppercased. Null / empty → null. */
export function awardKey(a: string | null | undefined): string | null {
  if (!a) return null;
  const u = a.toUpperCase();
  const m = u.match(/([A-Z]{2})\s*-?\s*0*(\d{5,6})/);
  return m ? `${m[1]}${m[2].padStart(6, "0")}` : u.replace(/[^A-Z0-9]/g, "") || null;
}

/** One `grant` row (dates `YYYY-MM-DD`). */
export type GrantRowInput = {
  id: string;
  cwid: string;
  name: string;
  title: string;
  role: string;
  funder: string;
  primeSponsor: string | null;
  mechanism: string | null;
  awardNumber: string | null;
  start: string;
  end: string;
};

export type AwardRow = {
  key: string;
  awardNumber: string | null;
  title: string;
  piCwid: string;
  piName: string;
  funder: string;
  mechanism: string | null;
  start: string;
  end: string;
  active: boolean;
  papers: number;
};

/** A grant row's collapse key: its award key, else the row itself. */
const rowKey = (g: Pick<GrantRowInput, "id" | "awardNumber">) =>
  awardKey(g.awardNumber) ?? `row:${g.id}`;

/**
 * Collapse to one row per award. Pure. `links` = (grant row id, pmid) pairs
 * for the core's confirmed papers; `rows` = every grant row of those awards
 * (the linked rows included). `asOf` = `YYYY-MM-DD`.
 */
export function collapseAwards(
  rows: readonly GrantRowInput[],
  links: ReadonlyArray<{ grantId: string; pmid: string }>,
  asOf: string,
): AwardRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pmidsByKey = new Map<string, Set<string>>();
  for (const l of links) {
    const g = byId.get(l.grantId);
    if (!g) continue;
    const k = rowKey(g);
    (pmidsByKey.get(k) ?? pmidsByKey.set(k, new Set()).get(k)!).add(l.pmid);
  }
  const rowsByKey = new Map<string, GrantRowInput[]>();
  for (const r of rows) {
    const k = rowKey(r);
    if (!pmidsByKey.has(k)) continue;
    (rowsByKey.get(k) ?? rowsByKey.set(k, []).get(k)!).push(r);
  }
  const out: AwardRow[] = [];
  for (const [key, group] of rowsByKey) {
    const ordered = [...group].sort(
      (a, b) => a.start.localeCompare(b.start) || a.cwid.localeCompare(b.cwid),
    );
    // The PI row: the latest PI row (its title is the current one), else the first holder.
    const pis = ordered.filter((r) => r.role === "PI");
    const lead = pis.length > 0 ? pis[pis.length - 1] : ordered[0];
    const start = ordered.reduce((m, r) => (r.start < m ? r.start : m), ordered[0].start);
    const end = ordered.reduce((m, r) => (r.end > m ? r.end : m), ordered[0].end);
    const pick = <T>(f: (r: GrantRowInput) => T | null): T | null =>
      f(lead) ?? ordered.map(f).find((v) => v !== null) ?? null;
    out.push({
      key,
      awardNumber: lead.awardNumber ?? pick((r) => r.awardNumber),
      title: lead.title,
      piCwid: lead.cwid,
      piName: lead.name,
      funder: lead.primeSponsor ?? pick((r) => r.primeSponsor) ?? lead.funder,
      mechanism: pick((r) => r.mechanism),
      start,
      end,
      active: start <= asOf && asOf <= end,
      papers: pmidsByKey.get(key)?.size ?? 0,
    });
  }
  return out.sort((a, b) => b.papers - a.papers || a.title.localeCompare(b.title));
}

export const NO_MECHANISM = "Not recorded";
const mechOf = (a: AwardRow) => a.mechanism ?? NO_MECHANISM;

export type FacetOption = { value: string; label: string; count: number };

export type CoreGrantsResult = {
  awards: AwardRow[];
  byFunder: { funder: string; grants: number; papers: number }[];
  /** Distinct confirmed papers linked to the listed awards. */
  linkedPapers: number;
  statusCounts: Record<GrantStatusFilter, number>;
  funderOptions: FacetOption[];
  mechOptions: FacetOption[];
};

/** The filters, the By funder roll-up and the rail counts (each facet counted
 *  with the OTHER filters applied, so a count is what ticking it would give).
 *  Pure. `pmidsByKey` feeds the distinct-paper total. */
export function filterAwards(
  all: readonly AwardRow[],
  p: CoreGrantsParams,
  pmidsByKey: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): CoreGrantsResult {
  const pass = (a: AwardRow, skip?: "status" | "funder" | "mech") =>
    (skip === "status" || p.status === "any" || a.active) &&
    (skip === "funder" || p.funders.length === 0 || p.funders.includes(a.funder)) &&
    (skip === "mech" || p.mechs.length === 0 || p.mechs.includes(mechOf(a)));
  const awards = all.filter((a) => pass(a));
  const count = (xs: readonly AwardRow[], f: (a: AwardRow) => string, selected: string[]) => {
    const m = new Map<string, number>(selected.map((s) => [s, 0]));
    for (const a of xs) m.set(f(a), (m.get(f(a)) ?? 0) + 1);
    return [...m]
      .map(([value, n]) => ({ value, label: value, count: n }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  const funders = new Map<string, { funder: string; grants: number; papers: number }>();
  for (const a of awards) {
    const f = funders.get(a.funder) ?? { funder: a.funder, grants: 0, papers: 0 };
    f.grants++;
    f.papers += a.papers;
    funders.set(a.funder, f);
  }
  const linked = new Set<string>();
  for (const a of awards) for (const pmid of pmidsByKey.get(a.key) ?? []) linked.add(pmid);
  const statusBase = all.filter((a) => pass(a, "status"));
  return {
    awards,
    byFunder: [...funders.values()].sort(
      (a, b) => b.grants - a.grants || a.funder.localeCompare(b.funder),
    ),
    linkedPapers: linked.size,
    statusCounts: { active: statusBase.filter((a) => a.active).length, any: statusBase.length },
    funderOptions: count(
      all.filter((a) => pass(a, "funder")),
      (a) => a.funder,
      p.funders,
    ),
    mechOptions: count(
      all.filter((a) => pass(a, "mech")),
      mechOf,
      p.mechs,
    ),
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The page's and the download's ONE loader: the links, every row of the
 *  linked awards, collapsed. */
export async function loadCoreGrantAwards(
  pmids: readonly string[],
  asOf: string,
): Promise<{ awards: AwardRow[]; pmidsByKey: Map<string, Set<string>> }> {
  const select = {
    id: true,
    cwid: true,
    title: true,
    role: true,
    funder: true,
    primeSponsor: true,
    mechanism: true,
    awardNumber: true,
    startDate: true,
    endDate: true,
    scholar: { select: { preferredName: true } },
  } as const;
  type Row = {
    id: string;
    cwid: string;
    title: string;
    role: string;
    funder: string;
    primeSponsor: string | null;
    mechanism: string | null;
    awardNumber: string | null;
    startDate: Date;
    endDate: Date;
    scholar: { preferredName: string } | null;
  };
  const toInput = (g: Row): GrantRowInput => ({
    id: g.id,
    cwid: g.cwid,
    name: g.scholar?.preferredName ?? g.cwid,
    title: g.title,
    role: g.role,
    funder: g.funder,
    primeSponsor: g.primeSponsor,
    mechanism: g.mechanism,
    awardNumber: g.awardNumber,
    start: iso(g.startDate),
    end: iso(g.endDate),
  });

  const links: { grantId: string; pmid: string }[] = [];
  const rows = new Map<string, GrantRowInput>();
  for (const batch of chunk(pmids)) {
    const found = await db.read.grantPublication.findMany({
      where: { pmid: { in: batch } },
      select: { pmid: true, grantId: true, grant: { select } },
    });
    for (const l of found) {
      links.push({ grantId: l.grantId, pmid: l.pmid });
      rows.set(l.grant.id, toInput(l.grant));
    }
  }
  // Every other row of the same awards (co-investigators' rows, renewals),
  // for the PI and the period.
  const numbers = [
    ...new Set([...rows.values()].map((r) => r.awardNumber).filter((n): n is string => !!n)),
  ];
  for (const batch of chunk(numbers)) {
    const more = await db.read.grant.findMany({ where: { awardNumber: { in: batch } }, select });
    for (const g of more) if (!rows.has(g.id)) rows.set(g.id, toInput(g));
  }
  const all = [...rows.values()];
  const awards = collapseAwards(all, links, asOf);
  const byId = new Map(all.map((r) => [r.id, r]));
  const pmidsByKey = new Map<string, Set<string>>();
  for (const l of links) {
    const g = byId.get(l.grantId);
    if (!g) continue;
    const k = rowKey(g);
    (pmidsByKey.get(k) ?? pmidsByKey.set(k, new Set()).get(k)!).add(l.pmid);
  }
  return { awards, pmidsByKey };
}

/** "Jul 2019 – Jun 2029". */
export function formatPeriod(start: string, end: string): string {
  const f = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  return `${f(start)} – ${f(end)}`;
}

export async function buildCoreGrantsWorkbook(
  coreName: string,
  p: CoreGrantsParams,
  r: CoreGrantsResult,
  asOf: string,
  generatedAt: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const list = (xs: string[]) => (xs.length > 0 ? xs.join("; ") : "All");
  addCriteriaSheet(wb, [
    ...coreCriteriaHead("13. Grants citing the core", coreName, generatedAt),
    ["Status", p.status === "active" ? `Active on ${asOf}` : STATUS_LABEL.any],
    ["Funder", list(p.funders)],
    ["Mechanism", list(p.mechs)],
    [
      "Counting rule",
      "One row per award: InfoEd rows for each person on an award and each renewal are combined by award number (institute code and serial number). Papers are the distinct confirmed publications of this core linked to the award.",
    ],
    ["Source", `Paper–grant links come from NIH RePORTER and ReCiter. ${NON_NIH_NOTE}`],
  ]);
  const grants = wb.addWorksheet("Grants");
  grants.addRow([
    "Award",
    "Title",
    "PI",
    "PI CWID",
    "Funder",
    "Mechanism",
    "Start",
    "End",
    "Status",
    "Linked papers",
  ]);
  boldRow(grants, 1);
  grants.views = [{ state: "frozen", ySplit: 1 }];
  for (const a of r.awards) {
    grants.addRow([
      a.awardNumber ?? a.key,
      a.title,
      a.piName,
      a.piCwid,
      a.funder,
      a.mechanism ?? "",
      a.start,
      a.end,
      a.active ? "Active" : "Ended",
      a.papers,
    ]);
  }
  for (const [i, w] of [20, 70, 28, 12, 16, 12, 12, 12, 10, 14].entries())
    grants.getColumn(i + 1).width = w;
  grants.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  const funders = wb.addWorksheet("By funder");
  funders.addRow(["Funder", "Grants", "Papers"]);
  boldRow(funders, 1);
  for (const f of r.byFunder) funders.addRow([f.funder, f.grants, f.papers]);
  funders.getColumn(1).width = 30;
  return workbookBuffer(wb);
}
