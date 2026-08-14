/**
 * The Reports IA redesign (2026-08-14) — `2a`/`1a`: a cross-unit Reports
 * index for an actor with more than one reportable unit (a center or
 * institute with a `CenterProgram` taxonomy). Single-unit actors never reach
 * this component — `app/edit/reports/page.tsx` falls straight through to
 * today's existing per-unit report list instead, unchanged.
 *
 * Two renderings of the SAME data, chosen by the page:
 * - `mode="table"` (2a, superuser/comms_steward with >3 units) — one row per
 *   unit, filter rail, row click opens that unit's report list
 *   (`/edit/reports?center=…`, today's existing page). Mirrors
 *   `AllUnitsDirectory`'s contract: server-bounded list, filter in-memory, no
 *   fetch, stretched-anchor rows (R7).
 * - `mode="bands"` (1a, everyone else with >1 unit) — every unit inline on one
 *   page, each in its own band with its 5 report rows beneath, so a multi-unit
 *   admin never has to leave the page to see any of it.
 *
 * "Live reports" / "N of 5" is real per-report data presence
 * (`lib/edit/cancer-center-reports.ts`'s `loadReportLiveness`), not a static
 * catalog flag — a not-live report renders as muted text, not a link.
 */
"use client";

import * as React from "react";
import Link from "next/link";

const TH_CLASS =
  "text-muted-foreground px-3 py-2 text-xs font-semibold tracking-wide whitespace-nowrap uppercase";

export type ReportsIndexReport = { n: 1 | 2 | 3 | 4 | 5; label: string; description: string };

export type ReportsIndexUnit = {
  code: string;
  name: string;
  centerType: "center" | "institute";
  editHref: string;
  liveCount: number;
  totalCount: number;
  /** ISO string (plain-serializable) or null — nothing live yet. */
  lastRefreshedAt: string | null;
  perReport: ReadonlyArray<{ n: 1 | 2 | 3 | 4 | 5; live: boolean; lastRefreshedAt: string | null }>;
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function typeLabel(centerType: "center" | "institute"): string {
  return centerType === "institute" ? "Institute" : "Center";
}

export function ReportsIndex({
  units,
  reports,
  mode,
}: {
  units: ReadonlyArray<ReportsIndexUnit>;
  reports: ReadonlyArray<ReportsIndexReport>;
  mode: "table" | "bands";
}) {
  return mode === "table" ? (
    <ReportsTable units={units} />
  ) : (
    <ReportsBands units={units} reports={reports} />
  );
}

type SortKey = "unit" | "live" | "refreshed";

function ReportsTable({ units }: { units: ReadonlyArray<ReportsIndexUnit> }) {
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>("unit");
  const [showCenters, setShowCenters] = React.useState(true);
  const [showInstitutes, setShowInstitutes] = React.useState(true);
  const [liveOnly, setLiveOnly] = React.useState(false);
  const [noneYetOnly, setNoneYetOnly] = React.useState(false);

  const counts = React.useMemo(
    () => ({
      centers: units.filter((u) => u.centerType === "center").length,
      institutes: units.filter((u) => u.centerType === "institute").length,
      liveOnly: units.filter((u) => u.liveCount > 0).length,
      noneYet: units.filter((u) => u.liveCount === 0).length,
    }),
    [units],
  );

  const filtered = React.useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const pool = units.filter((u) => {
      if (u.centerType === "center" && !showCenters) return false;
      if (u.centerType === "institute" && !showInstitutes) return false;
      if (liveOnly && u.liveCount === 0) return false;
      if (noneYetOnly && u.liveCount > 0) return false;
      if (trimmed.length === 0) return true;
      return u.name.toLowerCase().includes(trimmed);
    });
    if (sort === "live") {
      return [...pool].sort((a, b) => b.liveCount - a.liveCount || a.name.localeCompare(b.name));
    }
    if (sort === "refreshed") {
      return [...pool].sort((a, b) => {
        const at = a.lastRefreshedAt ? new Date(a.lastRefreshedAt).getTime() : -Infinity;
        const bt = b.lastRefreshedAt ? new Date(b.lastRefreshedAt).getTime() : -Infinity;
        return bt - at || a.name.localeCompare(b.name);
      });
    }
    return [...pool].sort((a, b) => a.name.localeCompare(b.name));
  }, [units, query, sort, showCenters, showInstitutes, liveOnly, noneYetOnly]);

  return (
    <div className="flex flex-col gap-4" data-slot="reports-index-table" data-testid="reports-index-table">
      <div className="grid grid-cols-[220px_1fr] items-start gap-5">
        <div className="border-apollo-border bg-apollo-surface-2 flex flex-col gap-4 rounded-xl border p-3">
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
            </div>
          </fieldset>
          <fieldset className="border-apollo-border border-t pt-3">
            <legend className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
              Reports
            </legend>
            <div className="flex flex-col gap-1">
              <FilterCheckbox
                checked={liveOnly}
                onChange={(v) => {
                  setLiveOnly(v);
                  if (v) setNoneYetOnly(false);
                }}
                label="Has live reports"
                count={counts.liveOnly}
                testid="reports-index-filter-has-live"
              />
              <FilterCheckbox
                checked={noneYetOnly}
                onChange={(v) => {
                  setNoneYetOnly(v);
                  if (v) setLiveOnly(false);
                }}
                label="None yet"
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
                <option value="live">Live reports</option>
                <option value="refreshed">Last refreshed</option>
              </select>
            </label>
            <span className="text-muted-foreground ml-auto text-sm">
              Showing {filtered.length} of {units.length}
            </span>
          </div>

          {filtered.length === 0 ? (
            <p className="text-muted-foreground text-sm">No units match the current filters.</p>
          ) : (
            <div className="border-apollo-border bg-apollo-surface overflow-hidden rounded-xl border">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm" data-testid="reports-index-rows">
                  <thead className="bg-apollo-surface-2">
                    <tr className="border-apollo-border border-b">
                      <th scope="col" className={TH_CLASS}>
                        Unit
                      </th>
                      <th scope="col" className={`${TH_CLASS} w-28`}>
                        Type
                      </th>
                      <th scope="col" className={`${TH_CLASS} w-28 text-right`}>
                        Live reports
                      </th>
                      <th scope="col" className={`${TH_CLASS} w-36 text-right`}>
                        Last refreshed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((u) => (
                      <tr
                        key={u.code}
                        className="border-apollo-border hover:bg-apollo-surface-2 focus-within:outline focus-within:-outline-offset-2 focus-within:outline-apollo-maroon relative border-t focus-within:outline-2"
                        data-testid={`reports-index-row-${u.code}`}
                      >
                        <td className="px-3 py-2.5 align-middle">
                          <Link
                            href={`/edit/reports?center=${encodeURIComponent(u.code)}`}
                            className="text-apollo-maroon font-medium after:absolute after:inset-0 hover:underline"
                            data-testid={`reports-index-link-${u.code}`}
                          >
                            {u.name}
                          </Link>
                        </td>
                        <td className="px-3 py-2.5 align-middle whitespace-nowrap">
                          {typeLabel(u.centerType)}
                        </td>
                        <td className="px-3 py-2.5 text-right align-middle tabular-nums whitespace-nowrap">
                          {u.liveCount > 0 ? `${u.liveCount} of ${u.totalCount}` : "—"}
                        </td>
                        <td className="text-muted-foreground px-3 py-2.5 text-right align-middle tabular-nums whitespace-nowrap">
                          {formatDate(u.lastRefreshedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            Row opens the unit&rsquo;s reports page.
          </p>
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

function ReportsBands({
  units,
  reports,
}: {
  units: ReadonlyArray<ReportsIndexUnit>;
  reports: ReadonlyArray<ReportsIndexReport>;
}) {
  return (
    <div className="border-apollo-border bg-apollo-surface overflow-hidden rounded-xl border" data-testid="reports-index-bands">
      <table className="w-full border-collapse text-left text-sm">
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
        {units.map((u) => {
          const liveByN = new Map(u.perReport.map((r) => [r.n, r]));
          return (
            <tbody key={u.code} data-testid={`reports-index-band-${u.code}`}>
              <tr className="bg-apollo-surface-2">
                <td colSpan={2} className="border-apollo-border border-t px-3 py-2 font-semibold">
                  {u.name}
                  <span className="text-muted-foreground ml-2 text-xs font-normal">
                    {typeLabel(u.centerType)} · {u.liveCount} of {u.totalCount} reports live
                  </span>
                </td>
                <td className="border-apollo-border border-t px-3 py-2 text-right">
                  <Link
                    href={u.editHref}
                    className="text-foreground relative z-10 text-xs hover:underline"
                    data-testid={`reports-index-edit-${u.code}`}
                  >
                    Edit center profile
                  </Link>
                </td>
              </tr>
              {reports.map((r) => {
                const live = liveByN.get(r.n);
                return live?.live ? (
                  <tr
                    key={r.n}
                    className="border-apollo-border hover:bg-apollo-surface-2 focus-within:outline focus-within:-outline-offset-2 focus-within:outline-apollo-maroon relative border-t focus-within:outline-2"
                  >
                    <td className="px-3 py-2.5 align-middle">
                      <Link
                        href={`/edit/reports/${r.n}?center=${encodeURIComponent(u.code)}`}
                        className="text-apollo-maroon font-medium after:absolute after:inset-0 hover:underline"
                        data-testid={`reports-index-band-link-${u.code}-${r.n}`}
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
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
