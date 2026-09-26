/**
 * `/edit/reports` — the reports index (Reports Index redesign, 2026-09-25;
 * mockup `More Reports/Reports Index Redesign.dc.html`). One list, grouped by
 * the unit each report covers, for every viewer: it replaced the three
 * renderings of the Reports IA redesign (2026-08-14) — the single-unit table
 * (`3a`), the per-unit bands (`1a`) and the superuser's filter-rail table
 * (`2a`).
 *
 * Each unit carries its OWN report catalog (`reports`, `perReport`) — a
 * center's six reports and a department/division/core's two (Publications,
 * NIH-funded pubs) are different lists (`REPORT_NUMBERS_BY_KIND`,
 * `lib/edit/cancer-center-reports.ts`). The pseudo-units (`institution`:
 * reports 8/9, `program`: report 7) have no org unit behind them.
 *
 * A row is a whole-row link card: '#N', name, summary, a meta line (who can
 * open it, as plain text the page computes with `accessSummary` — the same
 * string source as the report header's badge, so only the string, never the
 * grant rows behind "+ N others", reaches the client — and the data label)
 * and a chevron. A report with no
 * data yet stays listed as a muted, non-link row reading "No data yet", so a
 * unit's report count never varies night to night and a broken ETL is visible.
 * "In progress" means NCI Table 2A has rows left to review, nothing else.
 * Access is managed from the report's own Edit details sheet, never here.
 *
 * Filters (search, scope, In progress) run in memory over the props — the
 * list is server-bounded — and are mirrored into the URL (`q`, `scope`,
 * `review=1`) with `history.replaceState`, so a shared link reproduces the
 * view. A global viewer (superuser / comms steward) sees every department,
 * division and core; those stay off under "All" (their own segments show
 * them) unless a search is typed, which reaches every unit — or unless they
 * are ALL there is, when hiding them would open on an empty list.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, Users } from "lucide-react";

import {
  REPORTS_INDEX_SCOPES as SCOPES,
  type ReportsIndexScope,
} from "@/lib/edit/reports-index-scope";
import { cn } from "@/lib/utils";

/** Mirrors `ReportableUnitKind` (`lib/edit/cancer-center-reports.ts`) plus the
 *  two pseudo-units. Declared locally: this is a client component, and that
 *  module pulls the server-only reports data layer. */
export type ReportsIndexUnitKind =
  | "center"
  | "department"
  | "division"
  | "core"
  | "program"
  | "institution";
export type ReportN = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

const isPseudo = (k: ReportsIndexUnitKind) => k === "program" || k === "institution";

export type ReportsIndexReport = {
  n: ReportN;
  /** The report's CURRENT `report_meta.slug` — its canonical address. */
  slug: string;
  /** The bare report name (`report_meta.name`); the row prints '#N' apart. */
  name: string;
  description: string;
  /** Who can open it: `accessSummary(access).text`
   *  (`lib/edit/report-access-summary.ts`), computed on the server. */
  accessText: string;
};

export type ReportsIndexPerReport = {
  n: ReportN;
  live: boolean;
  /** ISO string (plain-serializable) or null. */
  lastRefreshedAt: string | null;
  /** Report 2 only: the latest import cycle, and its rows awaiting review. */
  reportingCycle?: string | null;
  toReview?: number;
};

export type ReportsIndexUnit = {
  code: string;
  kind: ReportsIndexUnitKind;
  name: string;
  editHref: string;
  reports: ReadonlyArray<ReportsIndexReport>;
  perReport: ReadonlyArray<ReportsIndexPerReport>;
};

/** Segments that appear only when the viewer has a unit of that kind. */
const OPTIONAL_SCOPES = new Set<string>(["department", "division", "core"]);

/** `/edit/reports/<slug>?center=<code>` — `&kind=` only for a department /
 *  division / core, so a `?center=<centerCode>` bookmark keeps resolving. A
 *  pseudo-unit's report is not unit-scoped: no params at all. */
function reportHref(slug: string, code: string, kind: ReportsIndexUnitKind): string {
  if (isPseudo(kind)) return `/edit/reports/${slug}`;
  const params = new URLSearchParams({ center: code });
  if (kind !== "center") params.set("kind", kind);
  return `/edit/reports/${slug}?${params.toString()}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    // Fixed zone so the server render and hydration agree.
    timeZone: "America/New_York",
  });
}

/** The meta line's data label. */
export function dataLabel(n: ReportN, p: ReportsIndexPerReport | undefined): string {
  if (!p?.live) return "No data yet";
  if (n === 1)
    return p.lastRefreshedAt ? `Snapshot · refreshed ${formatDate(p.lastRefreshedAt)}` : "Snapshot";
  if (n === 2 && p.reportingCycle) return `Cycle ${p.reportingCycle}`;
  return "Live data";
}

type Row = {
  unit: ReportsIndexUnit;
  report: ReportsIndexReport;
  live: boolean;
  data: string;
  toReview: number;
  haystack: string;
};

function buildRows(units: ReadonlyArray<ReportsIndexUnit>): Row[] {
  const rows: Row[] = [];
  for (const unit of units) {
    const byN = new Map(unit.perReport.map((p) => [p.n, p]));
    for (const report of [...unit.reports].sort((a, b) => a.n - b.n)) {
      const p = byN.get(report.n);
      const live = p?.live ?? false;
      rows.push({
        unit,
        report,
        live,
        data: dataLabel(report.n, p),
        toReview: report.n === 2 && live ? (p?.toReview ?? 0) : 0,
        haystack:
          `${report.name} ${report.description} ${unit.name} #${report.n} ${report.n}`.toLowerCase(),
      });
    }
  }
  return rows;
}

export function ReportsIndex({
  units,
  hideUnderAll = false,
  initialQuery = "",
  initialScope = "all",
  initialReview = false,
}: {
  /** In display order: the page puts Institution-wide and Mentoring programs first. */
  units: ReadonlyArray<ReportsIndexUnit>;
  /** A global viewer: departments / divisions / cores are off under "All". */
  hideUnderAll?: boolean;
  initialQuery?: string;
  initialScope?: ReportsIndexScope;
  initialReview?: boolean;
}) {
  const rows = React.useMemo(() => buildRows(units), [units]);
  const kindsPresent = React.useMemo(() => new Set<string>(units.map((u) => u.kind)), [units]);
  const segments = SCOPES.filter(([k]) => !OPTIONAL_SCOPES.has(k) || kindsPresent.has(k));
  // Only a report with an NCI 2A import can have rows to review; a "No data
  // yet" 2A row would show a meaningless "In progress 0".
  const hasReviewable = rows.some((r) => r.report.n === 2 && r.live);
  // Hiding departments / divisions / cores under "All" only makes sense beside
  // something else to show: a global viewer whose rows are all of those kinds
  // would otherwise open on "No reports match" with no filter to clear.
  const hide = hideUnderAll && rows.some((r) => !OPTIONAL_SCOPES.has(r.unit.kind));
  const reviewCount = rows.filter((r) => r.toReview > 0).length;

  const [query, setQuery] = React.useState(initialQuery);
  const [scope, setScope] = React.useState<ReportsIndexScope>(
    segments.some(([k]) => k === initialScope) ? initialScope : "all",
  );
  const [review, setReview] = React.useState(initialReview);

  // Mirror the filters into the URL (the #2792 pattern: a shared link
  // reproduces the view), keeping any other param (`?center=`, `?kind=`).
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const set = (key: string, value: string | null) =>
      value ? params.set(key, value) : params.delete(key);
    set("q", query.trim() || null);
    set("scope", scope === "all" ? null : scope);
    set("review", review ? "1" : null);
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [query, scope, review]);

  const q = query.trim().toLowerCase();
  const inScope = (r: Row, k: ReportsIndexScope) => {
    const kind = r.unit.kind;
    if (k === "all") return !(hide && OPTIONAL_SCOPES.has(kind)) || q !== "";
    return kind === k;
  };
  const matched = rows.filter(
    (r) => (q === "" || r.haystack.includes(q)) && (!review || r.toReview > 0),
  );
  const visible = matched.filter((r) => inScope(r, scope));

  const groups: Array<{ unit: ReportsIndexUnit; rows: Row[] }> = [];
  for (const r of visible) {
    const last = groups[groups.length - 1];
    if (last?.unit === r.unit) last.rows.push(r);
    else groups.push({ unit: r.unit, rows: [r] });
  }

  const clearFilters = () => {
    setQuery("");
    setScope("all");
    setReview(false);
  };

  return (
    <div data-testid="reports-index">
      <div className="mt-6 flex flex-wrap items-center gap-2.5">
        <input
          type="search"
          value={query}
          placeholder="Search reports"
          aria-label="Search reports"
          onChange={(e) => setQuery(e.target.value)}
          className="border-apollo-border-strong bg-apollo-surface h-9 w-full rounded-md border px-3 text-sm sm:w-72"
          data-testid="reports-index-search"
        />
        <div
          role="group"
          aria-label="Scope"
          className="bg-apollo-surface-2 border-apollo-border-strong flex flex-wrap gap-0.5 rounded-lg border p-[3px]"
        >
          {segments.map(([k, label]) => {
            const on = scope === k;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => setScope(k)}
                className={cn(
                  "rounded-md px-3 py-[5px] text-sm whitespace-nowrap tabular-nums",
                  on
                    ? "bg-apollo-surface text-foreground font-semibold shadow-[var(--apollo-shadow-card)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
                data-testid={`reports-index-scope-${k}`}
              >
                {label} {matched.filter((r) => inScope(r, k)).length}
              </button>
            );
          })}
        </div>
        {(hasReviewable || review) && (
          <button
            type="button"
            aria-pressed={review}
            onClick={() => setReview((v) => !v)}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium whitespace-nowrap",
              review
                ? "bg-apollo-amber border-apollo-amber text-white"
                : "bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber",
            )}
            data-testid="reports-index-review"
          >
            In progress <span className="font-bold tabular-nums">{reviewCount}</span>
          </button>
        )}
      </div>

      {groups.length === 0 ? (
        <div
          className="bg-apollo-surface border-apollo-border text-muted-foreground mt-7 rounded-[var(--apollo-radius-card)] border p-8 text-center text-[15px]"
          data-testid="reports-index-empty"
        >
          {rows.length === 0 ? (
            "No reports to show."
          ) : (
            <>
              No reports match.{" "}
              <button
                type="button"
                onClick={clearFilters}
                className="text-apollo-slate hover:underline"
              >
                Clear filters
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="mt-7 flex flex-col gap-7">
          {groups.map(({ unit, rows: unitRows }) => (
            <section
              key={`${unit.kind}:${unit.code}`}
              data-testid={`reports-index-group-${unit.code}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-1 pb-2.5">
                <h2 className="text-[17px] font-semibold">{unit.name}</h2>
                <span className="text-muted-foreground text-[13px]">
                  {unitRows.length} {unitRows.length === 1 ? "report" : "reports"}
                </span>
                {!isPseudo(unit.kind) && (
                  <Link
                    href={unit.editHref}
                    className="text-muted-foreground hover:text-foreground ml-auto text-xs hover:underline"
                    data-testid={`reports-index-edit-${unit.code}`}
                  >
                    Edit {unit.kind} profile
                  </Link>
                )}
              </div>
              <div className="bg-apollo-surface border-apollo-border divide-apollo-border divide-y overflow-hidden rounded-[var(--apollo-radius-card)] border shadow-[var(--apollo-shadow-card)]">
                {unitRows.map((r) => (
                  <ReportRow key={r.report.n} row={r} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ReportRow({ row }: { row: Row }) {
  const { unit, report, live, data, toReview } = row;
  const testId = `reports-index-row-${unit.code}-${report.n}`;
  const body = (
    <>
      <span className="text-muted-foreground pt-0.5 font-mono text-[13px] tabular-nums">
        #{report.n}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span
            className={cn(
              "text-base font-semibold",
              live ? "text-apollo-slate" : "text-muted-foreground",
            )}
          >
            {report.name}
          </span>
          {toReview > 0 && (
            <span
              className="text-apollo-amber bg-apollo-amber-tint border-apollo-amber-tint-border rounded-full border px-2 text-xs font-semibold whitespace-nowrap"
              data-testid={`reports-index-review-pill-${unit.code}`}
            >
              In progress · {toReview} to review
            </span>
          )}
        </div>
        <div
          className={cn(
            "mt-[3px] text-sm leading-normal",
            live ? "text-[#3d3833]" : "text-muted-foreground",
          )}
        >
          {report.description}
        </div>
        <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]">
          <span className="inline-flex items-center gap-[5px]" data-testid="reports-index-access">
            <Users size={13} aria-hidden className="shrink-0" />
            {report.accessText}
          </span>
          <span className="whitespace-nowrap" data-testid="reports-index-data">
            {data}
          </span>
        </div>
      </div>
      {live ? (
        <ChevronRight size={18} aria-hidden className="text-muted-foreground mt-0.5" />
      ) : (
        <span aria-hidden />
      )}
    </>
  );
  const grid =
    "grid grid-cols-[36px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-4 sm:grid-cols-[44px_minmax(0,1fr)_auto] sm:gap-x-4 sm:px-5";
  return live ? (
    <Link
      href={reportHref(report.slug, unit.code, unit.kind)}
      className={cn(
        grid,
        "hover:bg-apollo-page focus-visible:outline-apollo-maroon text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2",
      )}
      data-testid={testId}
    >
      {body}
    </Link>
  ) : (
    // A disabled link (the WAI-ARIA pattern): announced as an unavailable link,
    // not focusable, no href.
    <div className={grid} role="link" aria-disabled="true" data-testid={testId}>
      {body}
    </div>
  );
}
