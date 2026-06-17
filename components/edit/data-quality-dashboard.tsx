/**
 * The Data Quality dashboard table for `/edit/data-quality`
 * (`docs/data-quality-dashboard-spec.md`).
 *
 * Server-rendered with a plain GET form (person-type / department / gap /
 * hidden-roles filters + pagination all via query params), so it needs no client
 * JS — consistent with the rest of the server-rendered `/edit/*` surface. The page
 * supplies the Apollo header + `AdminSubnav`; this component renders only the
 * filter bar and the prominence-sorted table it is handed.
 *
 * Authorization/scope is the page's job; this component only renders what it gets.
 */
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { formatRoleCategory } from "@/lib/role-display";
import type {
  DataQualityCounts,
  DataQualityEntry,
  DataQualityGapFilter,
} from "@/lib/api/data-quality";
import type { RosterFacets } from "@/lib/api/edit-roster";

export type DataQualityDashboardProps = {
  entries: ReadonlyArray<DataQualityEntry>;
  total: number;
  counts: DataQualityCounts;
  /** Dropdown option lists for the department + person-type filters. */
  facets: RosterFacets;
  /** Selected person-type (roleCategory) filter, raw DB value or "". */
  roleCategory: string;
  /** Selected department-code filter or "". */
  deptCode: string;
  gap: DataQualityGapFilter;
  includeHidden: boolean;
  page: number;
  pageSize: number;
};

const BASE = "/edit/data-quality";

function pageHref(opts: {
  page: number;
  roleCategory: string;
  deptCode: string;
  gap: DataQualityGapFilter;
  includeHidden: boolean;
}): string {
  const p = new URLSearchParams();
  if (opts.roleCategory) p.set("type", opts.roleCategory);
  if (opts.deptCode) p.set("dept", opts.deptCode);
  if (opts.gap !== "all") p.set("gap", opts.gap);
  if (!opts.includeHidden) p.set("hidden", "0");
  if (opts.page > 0) p.set("page", String(opts.page));
  const qs = p.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

/** The CSV-export URL carrying the current filters (no page — export is unpaginated). */
function exportHref(opts: {
  roleCategory: string;
  deptCode: string;
  gap: DataQualityGapFilter;
  includeHidden: boolean;
}): string {
  const p = new URLSearchParams();
  if (opts.roleCategory) p.set("type", opts.roleCategory);
  if (opts.deptCode) p.set("dept", opts.deptCode);
  if (opts.gap !== "all") p.set("gap", opts.gap);
  if (!opts.includeHidden) p.set("hidden", "0");
  const qs = p.toString();
  return qs ? `${BASE}/export?${qs}` : `${BASE}/export`;
}

/** A green ✓ (good) or muted "—" (not checked / n/a). */
function Yes() {
  return <span className="font-semibold text-emerald-600" aria-label="yes">✓</span>;
}
function Gap() {
  return <span className="text-apollo-maroon font-semibold" aria-label="missing">✗</span>;
}
function Unknown() {
  return (
    <span className="text-muted-foreground" aria-label="not checked" title="Not checked yet">
      —
    </span>
  );
}

export function DataQualityDashboard({
  entries,
  total,
  counts,
  facets,
  roleCategory,
  deptCode,
  gap,
  includeHidden,
  page,
  pageSize,
}: DataQualityDashboardProps) {
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  const hasPrev = page > 0;
  const hasNext = end < total;

  return (
    <div data-slot="data-quality-dashboard">
      {/* Summary chips across the in-scope set (before the gap filter). */}
      <div className="text-muted-foreground mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>
          <strong className="text-foreground">{counts.inScope.toLocaleString()}</strong> in scope
        </span>
        <span>
          <strong className="text-foreground">{counts.missingHeadshot.toLocaleString()}</strong> no
          headshot
        </span>
        <span>
          <strong className="text-foreground">{counts.missingOverview.toLocaleString()}</strong> no
          overview
        </span>
        <span>
          <strong className="text-foreground">{counts.withCoi.toLocaleString()}</strong> with COI to
          review
        </span>
      </div>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3" data-testid="dq-filter-form">
        <div className="flex flex-col gap-1">
          <label htmlFor="dq-type" className="text-muted-foreground text-xs">
            Person type
          </label>
          <select
            id="dq-type"
            name="type"
            defaultValue={roleCategory}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
          >
            <option value="">All</option>
            {facets.roleCategories.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="dq-dept" className="text-muted-foreground text-xs">
            Department
          </label>
          <select
            id="dq-dept"
            name="dept"
            defaultValue={deptCode}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
          >
            <option value="">All departments</option>
            {facets.departments.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="dq-gap" className="text-muted-foreground text-xs">
            Gap
          </label>
          <select
            id="dq-gap"
            name="gap"
            defaultValue={gap}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
          >
            <option value="all">Any</option>
            <option value="no-headshot">Missing headshot</option>
            <option value="no-overview">Missing overview</option>
            <option value="has-coi">Has COI to review</option>
          </select>
        </div>

        <label className="flex items-center gap-2 pb-2 text-sm" htmlFor="dq-hidden">
          <input
            id="dq-hidden"
            type="checkbox"
            name="hidden"
            value="0"
            defaultChecked={!includeHidden}
            className="size-4"
          />
          Hide students &amp; alumni
        </label>

        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <div className="mb-2 flex items-center justify-between">
        <div className="text-muted-foreground text-sm" data-testid="dq-result-count">
          {total === 0 ? "No scholars match these filters." : `Showing ${start}–${end} of ${total}`}
        </div>
        {total > 0 && (
          <a
            href={exportHref({ roleCategory, deptCode, gap, includeHidden })}
            className="text-sm hover:underline"
            data-testid="dq-export-link"
          >
            Download CSV
          </a>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="dq-table">
          <thead className="bg-muted/50 text-muted-foreground text-left text-xs uppercase">
            <tr>
              <th className="w-12 px-3 py-2">#</th>
              <th className="px-3 py-2">Scholar</th>
              <th className="px-3 py-2">Person type</th>
              <th className="px-3 py-2 text-center">Headshot</th>
              <th className="px-3 py-2 text-center">Overview</th>
              <th className="px-3 py-2 text-center">COI</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={e.cwid} className="border-t" data-testid="dq-row">
                <td className="text-muted-foreground px-3 py-2 tabular-nums" title={`Prominence ${e.prominence.toFixed(1)}`}>
                  {page * pageSize + i + 1}
                </td>
                <td className="px-3 py-2">
                  <Link href={e.editHref} className="text-apollo-maroon font-medium hover:underline">
                    {e.name}
                  </Link>
                  {(e.isChair || e.isChief) && (
                    <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-xs">
                      {e.isChair ? "Chair" : "Chief"}
                    </span>
                  )}
                  <div className="text-muted-foreground text-xs">
                    {[e.title, e.unit].filter(Boolean).join(" · ") || e.cwid}
                  </div>
                </td>
                <td className="px-3 py-2">{formatRoleCategory(e.roleCategory) ?? "—"}</td>
                <td className="px-3 py-2 text-center">
                  {e.headshot === "present" ? <Yes /> : e.headshot === "missing" ? <Gap /> : <Unknown />}
                </td>
                <td className="px-3 py-2 text-center">{e.hasOverview ? <Yes /> : <Gap />}</td>
                <td className="px-3 py-2 text-center">
                  {e.pendingCoiHigh > 0 ? (
                    <span
                      className="bg-apollo-maroon inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold text-white"
                      title={
                        e.pendingCoiMedium > 0
                          ? `${e.pendingCoiHigh} to review · ${e.pendingCoiMedium} likely covered`
                          : `${e.pendingCoiHigh} to review`
                      }
                    >
                      {e.pendingCoiHigh}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Link href={e.editHref} className="text-muted-foreground hover:text-foreground text-xs">
                    Edit →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(hasPrev || hasNext) && (
        <div className="mt-4 flex items-center justify-between">
          {hasPrev ? (
            <Link
              href={pageHref({ page: page - 1, roleCategory, deptCode, gap, includeHidden })}
              className="text-sm hover:underline"
            >
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          {hasNext ? (
            <Link
              href={pageHref({ page: page + 1, roleCategory, deptCode, gap, includeHidden })}
              className="text-sm hover:underline"
            >
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
