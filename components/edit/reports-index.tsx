/**
 * The Reports IA redesign (2026-08-14) — `2a`/`1a`/`3a`. Widened to
 * department/division units by the org-unit publications reports plan
 * (2026-08-16): each unit now carries its OWN report catalog (`reports`,
 * `perReport`), since a center's six reports and a department/division's two
 * (Publications, NIH-funded pubs) are different lists, not one shared list
 * with some rows "not live yet" — a department never shows a card for a
 * report it structurally can't produce (`REPORT_NUMBERS_BY_KIND`,
 * `lib/edit/cancer-center-reports.ts`).
 *
 * Three renderings of the same underlying per-report data
 * (`lib/edit/cancer-center-reports.ts`'s `loadReportLiveness`), chosen by the
 * page:
 * - `mode="table"` (2a, superuser/comms_steward with 2+ units) — one row per
 *   (unit, report) pair, each unit's own report catalog flattened out so the
 *   Status column reads per-report instead of as a unit-level "N of M"
 *   rollup. Filter rail narrows by unit type (still unit-scoped) and by
 *   per-report status (Live/In progress, now row-scoped). A live row's click
 *   target is that report itself (`/edit/reports/N?center=…`); a non-live row
 *   has no link. Mirrors `AllUnitsDirectory`'s contract: server-bounded list,
 *   filter in-memory, no fetch, stretched-anchor rows (R7).
 * - `mode="bands"` (1a, everyone else with >1 unit) — every unit inline on one
 *   page, each in its own band with its own report rows beneath, so a
 *   multi-unit admin never has to leave the page to see any of it.
 * - `SingleUnitReportsTable` (3a — an actor with exactly one reportable unit,
 *   the common case today) — the SAME `Report | Focus | Last refreshed`
 *   table as one band's body, just without the band header (the page's own
 *   `<h1>` already names the unit). Exported separately since it's rendered
 *   from `app/edit/reports/page.tsx` directly, not through `ReportsIndex`.
 *
 * "Live" / "In progress" (table) and "N of M reports live" (bands' per-unit
 * summary) are both real per-report data presence, not a static catalog flag
 * — a not-live report renders as muted text, not a link, wherever it appears.
 */
"use client";

import * as React from "react";
import Link from "next/link";

const TH_CLASS =
  "text-muted-foreground px-3 py-2 text-xs font-semibold tracking-wide whitespace-nowrap uppercase";

export type ReportsIndexUnitKind = "center" | "department" | "division";

export type ReportsIndexReport = { n: 1 | 2 | 3 | 4 | 5 | 6; label: string; description: string };

export type ReportsIndexUnit = {
  code: string;
  kind: ReportsIndexUnitKind;
  name: string;
  /** Only meaningful when `kind === "center"`; null for department/division
   *  (no institute-vs-center distinction outside a center). */
  centerType: "center" | "institute" | null;
  editHref: string;
  liveCount: number;
  totalCount: number;
  /** ISO string (plain-serializable) or null — nothing live yet. */
  lastRefreshedAt: string | null;
  /** This unit's OWN report catalog — `REPORT_NUMBERS_BY_KIND[kind]` resolved
   *  to labels/descriptions. A center carries all six; department/division
   *  carry only Publications + NIH-funded pubs. */
  reports: ReadonlyArray<ReportsIndexReport>;
  perReport: ReadonlyArray<{ n: 1 | 2 | 3 | 4 | 5 | 6; live: boolean; lastRefreshedAt: string | null }>;
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function typeLabel(u: { kind: ReportsIndexUnitKind; centerType: "center" | "institute" | null }): string {
  if (u.kind === "department") return "Department";
  if (u.kind === "division") return "Division";
  return u.centerType === "institute" ? "Institute" : "Center";
}

/** `/edit/reports/N?center=<code>` — `&kind=` is only appended for a
 *  department/division so an existing `?center=<centerCode>` bookmark (implied
 *  `kind=center`) keeps resolving exactly as it always has. */
function reportHref(n: number, code: string, kind: ReportsIndexUnitKind): string {
  const params = new URLSearchParams({ center: code });
  if (kind !== "center") params.set("kind", kind);
  return `/edit/reports/${n}?${params.toString()}`;
}

export function ReportsIndex({
  units,
  mode,
}: {
  units: ReadonlyArray<ReportsIndexUnit>;
  mode: "table" | "bands";
}) {
  return mode === "table" ? <ReportsTable units={units} /> : <ReportsBands units={units} />;
}

type SortKey = "unit" | "status" | "refreshed";

/** One (org unit, report) pair — the table's actual row grain. Flattened from
 *  a unit's own `reports` catalog against its `perReport` liveness, the same
 *  lookup `ReportRows` below already does per unit. */
type FlatRow = {
  unitCode: string;
  unitKind: ReportsIndexUnitKind;
  unitName: string;
  centerType: "center" | "institute" | null;
  reportN: 1 | 2 | 3 | 4 | 5 | 6;
  reportLabel: string;
  live: boolean;
  lastRefreshedAt: string | null;
};

function ReportsTable({ units }: { units: ReadonlyArray<ReportsIndexUnit> }) {
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>("unit");
  const [showCenters, setShowCenters] = React.useState(true);
  const [showInstitutes, setShowInstitutes] = React.useState(true);
  // Default unchecked, matching the mockup's own default state for these
  // buckets — a department/division row stays hidden until explicitly toggled
  // on, same posture the mockup gave the (formerly always-empty) Department
  // checkbox.
  const [showDepartments, setShowDepartments] = React.useState(false);
  const [showDivisions, setShowDivisions] = React.useState(false);
  const [liveOnly, setLiveOnly] = React.useState(false);
  const [noneYetOnly, setNoneYetOnly] = React.useState(false);

  const rows = React.useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    for (const u of units) {
      const liveByN = new Map(u.perReport.map((r) => [r.n, r]));
      for (const r of u.reports) {
        const live = liveByN.get(r.n);
        out.push({
          unitCode: u.code,
          unitKind: u.kind,
          unitName: u.name,
          centerType: u.centerType,
          reportN: r.n,
          reportLabel: r.label,
          live: live?.live ?? false,
          lastRefreshedAt: live?.lastRefreshedAt ?? null,
        });
      }
    }
    return out;
  }, [units]);

  const counts = React.useMemo(
    () => ({
      centers: units.filter((u) => u.kind === "center" && u.centerType !== "institute").length,
      institutes: units.filter((u) => u.kind === "center" && u.centerType === "institute").length,
      departments: units.filter((u) => u.kind === "department").length,
      divisions: units.filter((u) => u.kind === "division").length,
      // Row-scoped (per report), not unit-scoped — a unit with 1 of 6 reports
      // live now contributes 1 row to liveOnly and 5 to noneYet, instead of
      // reading as "has a live report" and never surfacing in "In progress".
      liveOnly: rows.filter((r) => r.live).length,
      noneYet: rows.filter((r) => !r.live).length,
    }),
    [units, rows],
  );

  const filtered = React.useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const pool = rows.filter((r) => {
      if (r.unitKind === "center" && r.centerType !== "institute" && !showCenters) return false;
      if (r.unitKind === "center" && r.centerType === "institute" && !showInstitutes) return false;
      if (r.unitKind === "department" && !showDepartments) return false;
      if (r.unitKind === "division" && !showDivisions) return false;
      if (liveOnly && !r.live) return false;
      if (noneYetOnly && r.live) return false;
      if (trimmed.length === 0) return true;
      return r.unitName.toLowerCase().includes(trimmed);
    });
    if (sort === "status") {
      return [...pool].sort(
        (a, b) =>
          Number(b.live) - Number(a.live) ||
          a.unitName.localeCompare(b.unitName) ||
          a.reportLabel.localeCompare(b.reportLabel),
      );
    }
    if (sort === "refreshed") {
      return [...pool].sort((a, b) => {
        const at = a.lastRefreshedAt ? new Date(a.lastRefreshedAt).getTime() : -Infinity;
        const bt = b.lastRefreshedAt ? new Date(b.lastRefreshedAt).getTime() : -Infinity;
        return bt - at || a.unitName.localeCompare(b.unitName) || a.reportLabel.localeCompare(b.reportLabel);
      });
    }
    return [...pool].sort(
      (a, b) => a.unitName.localeCompare(b.unitName) || a.reportLabel.localeCompare(b.reportLabel),
    );
  }, [rows, query, sort, showCenters, showInstitutes, showDepartments, showDivisions, liveOnly, noneYetOnly]);

  return (
    <div className="flex flex-col gap-4" data-slot="reports-index-table" data-testid="reports-index-table">
      <div className="grid grid-cols-[220px_1fr] items-start gap-5">
        <div className="border-apollo-rail-border bg-apollo-rail flex flex-col gap-4 rounded-xl border p-3">
          <fieldset>
            <legend className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
              Unit type
            </legend>
            <div className="flex flex-col gap-1">
              <FilterCheckbox
                checked={showCenters}
                onChange={setShowCenters}
                label="Center"
                count={counts.centers}
                testid="reports-index-filter-center"
              />
              <FilterCheckbox
                checked={showInstitutes}
                onChange={setShowInstitutes}
                label="Institute"
                count={counts.institutes}
                testid="reports-index-filter-institute"
              />
              <FilterCheckbox
                checked={showDepartments}
                onChange={setShowDepartments}
                label="Department"
                count={counts.departments}
                testid="reports-index-filter-department"
              />
              <FilterCheckbox
                checked={showDivisions}
                onChange={setShowDivisions}
                label="Division"
                count={counts.divisions}
                testid="reports-index-filter-division"
              />
            </div>
          </fieldset>
          <fieldset className="border-apollo-border border-t">
            <legend className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
              Status
            </legend>
            <div className="flex flex-col gap-1">
              <FilterCheckbox
                checked={liveOnly}
                onChange={(v) => {
                  setLiveOnly(v);
                  if (v) setNoneYetOnly(false);
                }}
                label="Live"
                count={counts.liveOnly}
                testid="reports-index-filter-has-live"
              />
              <FilterCheckbox
                checked={noneYetOnly}
                onChange={(v) => {
                  setNoneYetOnly(v);
                  if (v) setLiveOnly(false);
                }}
                label="In progress"
                count={counts.noneYet}
                testid="reports-index-filter-none-yet"
              />
            </div>
          </fieldset>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={query}
              placeholder="Filter by unit name…"
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter units"
              className="border-apollo-border-strong bg-apollo-surface h-9 w-70 rounded-md border px-3 text-sm"
              data-testid="reports-index-filter-name"
            />
            <label className="text-muted-foreground flex items-center gap-2 text-sm">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="border-apollo-border-strong text-foreground h-9 rounded-md border bg-apollo-surface px-2 text-sm"
                data-testid="reports-index-sort"
              >
                <option value="unit">Unit</option>
                <option value="status">Status</option>
                <option value="refreshed">Last refreshed</option>
              </select>
            </label>
            <span className="text-muted-foreground ml-auto text-sm">
              Showing {filtered.length} of {rows.length}
            </span>
          </div>

          {filtered.length === 0 ? (
            <p className="text-muted-foreground text-sm">No reports match the current filters.</p>
          ) : (
            <div className="border-apollo-border bg-apollo-surface overflow-hidden rounded-xl border">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm" data-testid="reports-index-rows">
                  <thead className="bg-apollo-surface-2">
                    <tr className="border-apollo-border border-b">
                      <th scope="col" className={`${TH_CLASS} w-60`}>
                        Report
                      </th>
                      <th scope="col" className={TH_CLASS}>
                        Org unit
                      </th>
                      <th scope="col" className={`${TH_CLASS} w-28`}>
                        Type
                      </th>
                      <th scope="col" className={`${TH_CLASS} w-28`}>
                        Status
                      </th>
                      <th scope="col" className={`${TH_CLASS} w-36 text-right`}>
                        Last refreshed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr
                        key={`${r.unitCode}-${r.reportN}`}
                        className="border-apollo-border hover:bg-apollo-surface-2 focus-within:outline focus-within:-outline-offset-2 focus-within:outline-apollo-maroon relative border-t focus-within:outline-2"
                        data-testid={`reports-index-row-${r.unitCode}-${r.reportN}`}
                      >
                        <td className="px-3 py-2.5 align-middle">
                          {r.live ? (
                            <Link
                              href={reportHref(r.reportN, r.unitCode, r.unitKind)}
                              className="text-apollo-maroon font-medium after:absolute after:inset-0 hover:underline"
                              data-testid={`reports-index-link-${r.unitCode}-${r.reportN}`}
                            >
                              {r.reportLabel}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">{r.reportLabel}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 align-middle">{r.unitName}</td>
                        <td className="px-3 py-2.5 align-middle whitespace-nowrap">
                          {typeLabel({ kind: r.unitKind, centerType: r.centerType })}
                        </td>
                        <td className="px-3 py-2.5 align-middle whitespace-nowrap">
                          {r.live ? "Live" : "In progress"}
                        </td>
                        <td className="text-muted-foreground px-3 py-2.5 text-right align-middle tabular-nums whitespace-nowrap">
                          {formatDate(r.lastRefreshedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <p className="text-muted-foreground text-xs">Row opens the report.</p>
        </div>
      </div>
    </div>
  );
}

function FilterCheckbox({
  checked,
  onChange,
  label,
  count,
  testid,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  count: number;
  testid: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-0.5 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-apollo-maroon"
        data-testid={testid}
      />
      {label}
      <span className="text-muted-foreground ml-auto text-xs tabular-nums">{count}</span>
    </label>
  );
}

type PerReport = ReportsIndexUnit["perReport"][number];

/** One unit's report rows — shared by a band body (`ReportsBands`) and the
 *  band-less single-unit table (`SingleUnitReportsTable`). A live report is a
 *  stretched-anchor link to `/edit/reports/N?center=…`; not-live renders as
 *  plain muted text, matching the "advisory, not a promise" tone of the rest
 *  of this console. `reports` is THIS unit's own catalog — see the module
 *  doc comment for why it's no longer a shared prop. */
function ReportRows({
  perReport,
  reports,
  unitCode,
  unitKind,
}: {
  perReport: ReadonlyArray<PerReport>;
  reports: ReadonlyArray<ReportsIndexReport>;
  unitCode: string;
  unitKind: ReportsIndexUnitKind;
}) {
  const liveByN = new Map(perReport.map((r) => [r.n, r]));
  return (
    <>
      {reports.map((r) => {
        const live = liveByN.get(r.n);
        return live?.live ? (
          <tr
            key={r.n}
            className="border-apollo-border hover:bg-apollo-surface-2 focus-within:outline focus-within:-outline-offset-2 focus-within:outline-apollo-maroon relative border-t focus-within:outline-2"
          >
            <td className="px-3 py-2.5 align-middle">
              <Link
                href={reportHref(r.n, unitCode, unitKind)}
                className="text-apollo-maroon font-medium after:absolute after:inset-0 hover:underline"
                data-testid={`reports-index-band-link-${unitCode}-${r.n}`}
              >
                {r.label}
              </Link>
            </td>
            <td className="px-3 py-2.5 align-middle">{r.description}</td>
            <td className="text-muted-foreground px-3 py-2.5 text-right align-middle tabular-nums whitespace-nowrap">
              {formatDate(live.lastRefreshedAt)}
            </td>
          </tr>
        ) : (
          <tr key={r.n} className="border-apollo-border text-muted-foreground border-t">
            <td className="px-3 py-2.5 align-middle">{r.label}</td>
            <td className="px-3 py-2.5 align-middle">Nothing live yet for this unit.</td>
            <td className="px-3 py-2.5 text-right align-middle">—</td>
          </tr>
        );
      })}
    </>
  );
}

const REPORT_TABLE_HEAD = (
  <thead className="bg-apollo-surface-2">
    <tr className="border-apollo-border border-b">
      <th scope="col" className={`${TH_CLASS} w-60`}>
        Report
      </th>
      <th scope="col" className={TH_CLASS}>
        Focus
      </th>
      <th scope="col" className={`${TH_CLASS} w-36 text-right`}>
        Last refreshed
      </th>
    </tr>
  </thead>
);

function ReportsBands({ units }: { units: ReadonlyArray<ReportsIndexUnit> }) {
  return (
    <div className="border-apollo-border bg-apollo-surface overflow-hidden rounded-xl border" data-testid="reports-index-bands">
      <table className="w-full border-collapse text-left text-sm">
        {REPORT_TABLE_HEAD}
        {units.map((u) => (
          <tbody key={u.code} data-testid={`reports-index-band-${u.code}`}>
            <tr className="bg-apollo-surface-2">
              <td colSpan={2} className="border-apollo-border border-t px-3 py-2 font-semibold">
                {u.name}
                <span className="text-muted-foreground ml-2 text-xs font-normal">
                  {typeLabel(u)} · {u.liveCount} of {u.totalCount} reports live
                </span>
              </td>
              <td className="border-apollo-border border-t px-3 py-2 text-right">
                <Link
                  href={u.editHref}
                  className="text-foreground relative z-10 text-xs hover:underline"
                  data-testid={`reports-index-edit-${u.code}`}
                >
                  Edit {u.kind === "center" ? "center" : u.kind} profile
                </Link>
              </td>
            </tr>
            <ReportRows perReport={u.perReport} reports={u.reports} unitCode={u.code} unitKind={u.kind} />
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** `3a` — an actor with exactly one reportable unit. Same table shape as one
 *  band's body, no band header (the page's own `<h1>` already names the
 *  unit) — replaces the old plain divided list. */
export function SingleUnitReportsTable({
  unitCode,
  unitKind = "center",
  perReport,
  reports,
}: {
  unitCode: string;
  /** Defaults to `"center"` so existing callers built before department/
   *  division report links existed keep resolving the same URLs. */
  unitKind?: ReportsIndexUnitKind;
  perReport: ReadonlyArray<PerReport>;
  reports: ReadonlyArray<ReportsIndexReport>;
}) {
  return (
    <div
      className="border-apollo-border bg-apollo-surface overflow-hidden rounded-xl border"
      data-testid="single-unit-reports-table"
    >
      <table className="w-full border-collapse text-left text-sm">
        {REPORT_TABLE_HEAD}
        <tbody>
          <ReportRows perReport={perReport} reports={reports} unitCode={unitCode} unitKind={unitKind} />
        </tbody>
      </table>
    </div>
  );
}
