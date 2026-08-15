/**
 * The COI dashboard table for `/edit/coi` — pending conflict-of-interest
 * review, superuser-only (`app/edit/coi/page.tsx`). A trimmed sibling of
 * `components/edit/profiles-roster.tsx`: same prominence-sorted, leadership-
 * badged table shape, but the only signal it shows is COI — no Status, no
 * headshot/overview, no "View as" action. Server-rendered; the filter sidebar
 * is a small client island (`CoiFilters`).
 *
 * Authorization is the page's job; this component only renders what it's handed.
 */
import Link from "next/link";

import { CoiFilters } from "@/components/edit/coi-filters";
import { formatRoleCategory } from "@/lib/role-display";
import type {
  DataQualityCounts,
  DataQualityEntry,
  DataQualityFacets,
  DataQualityGapFilter,
} from "@/lib/api/data-quality";

export type CoiRosterProps = {
  entries: ReadonlyArray<DataQualityEntry>;
  total: number;
  counts: DataQualityCounts;
  facets: DataQualityFacets;
  roleCategories: string[];
  units: string[];
  q: string;
  gap: DataQualityGapFilter;
  includeHidden: boolean;
  page: number;
  pageSize: number;
};

const BASE = "/edit/coi";

type FilterState = {
  roleCategories: string[];
  units: string[];
  q: string;
  gap: DataQualityGapFilter;
  includeHidden: boolean;
};

function filterParams(f: FilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  for (const r of f.roleCategories) p.append("type", r);
  for (const u of f.units) p.append("unit", u);
  if (f.gap !== "all") p.set("gap", f.gap);
  if (!f.includeHidden) p.set("hidden", "0");
  return p;
}

function pageHref(f: FilterState, page: number): string {
  const p = filterParams(f);
  if (page > 0) p.set("page", String(page));
  const qs = p.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

/** The CSV-export URL carrying the current filters (no page — export is unpaginated). */
function exportHref(f: FilterState): string {
  const qs = filterParams(f).toString();
  return qs ? `${BASE}/export?${qs}` : `${BASE}/export`;
}

export function CoiRoster({
  entries,
  total,
  counts,
  facets,
  roleCategories,
  units,
  q,
  gap,
  includeHidden,
  page,
  pageSize,
}: CoiRosterProps) {
  const filters: FilterState = { roleCategories, units, q, gap, includeHidden };
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  const hasPrev = page > 0;
  const hasNext = end < total;

  return (
    <div data-slot="coi-roster">
      <h1 className="mb-1 text-xl font-semibold">COI</h1>
      <p className="text-muted-foreground mb-6 text-sm">
        Every scholar, most prominent first, with unreviewed conflict-of-interest suggestions.
        Select a row to open that profile's editor.
      </p>

      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="lg:w-64 lg:shrink-0">
          <CoiFilters
            facets={facets}
            roleCategories={roleCategories}
            units={units}
            q={q}
            gap={gap}
            includeHidden={includeHidden}
          />
        </aside>

        <div className="min-w-0 flex-1">
          {/* Summary chips across the in-scope set (before the gap filter). */}
          <div className="text-muted-foreground mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>
              <strong className="text-foreground">{counts.inScope.toLocaleString()}</strong> in scope
            </span>
            <span>
              <strong className="text-foreground">{counts.withCoi.toLocaleString()}</strong> with COI to
              review
            </span>
          </div>

          <div className="mb-2 flex items-center justify-between">
            <div className="text-muted-foreground text-sm" data-testid="coi-result-count">
              {total === 0
                ? "No scholars match these filters."
                : `Showing ${start}–${end} of ${total}`}
            </div>
            {total > 0 && (
              <a href={exportHref(filters)} className="text-sm hover:underline" data-testid="coi-export-link">
                Download CSV
              </a>
            )}
          </div>

          <div className="border-apollo-border bg-apollo-surface overflow-x-auto rounded-md border">
            <table className="[&_td]:align-middle w-full text-sm" data-testid="coi-table">
              <thead className="bg-apollo-surface-2 text-muted-foreground text-left text-xs uppercase">
                <tr>
                  <th className="w-12 px-3 py-2">#</th>
                  <th className="px-3 py-2">Scholar</th>
                  <th className="px-3 py-2">Person type</th>
                  <th className="px-3 py-2 text-center">COI</th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-muted-foreground px-3 py-6 text-center">
                      No scholars match these filters.
                    </td>
                  </tr>
                ) : (
                  entries.map((e, i) => (
                    <tr key={e.cwid} className="border-t" data-testid="coi-row">
                      <td
                        className="text-muted-foreground px-3 py-2 tabular-nums"
                        title={`Prominence ${e.prominence.toFixed(1)}`}
                      >
                        {page * pageSize + i + 1}
                      </td>
                      <td className="px-3 py-2">
                        <Link href={e.editHref} className="text-apollo-maroon font-medium hover:underline">
                          {e.name}
                        </Link>
                        {e.leadership && (
                          <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-xs">
                            {e.leadership}
                          </span>
                        )}
                        <div className="text-muted-foreground text-xs">
                          {[e.title, e.unit].filter(Boolean).join(" · ") || e.cwid}
                        </div>
                      </td>
                      <td className="px-3 py-2">{formatRoleCategory(e.roleCategory) ?? "—"}</td>
                      <td className="px-3 py-2 text-center">
                        {e.pendingCoiHigh > 0 ? (
                          <span
                            className="bg-muted text-muted-foreground inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold"
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
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {(hasPrev || hasNext) && (
            <div className="mt-4 flex items-center justify-between">
              {hasPrev ? (
                <Link href={pageHref(filters, page - 1)} className="text-sm hover:underline">
                  ← Previous
                </Link>
              ) : (
                <span />
              )}
              {hasNext ? (
                <Link href={pageHref(filters, page + 1)} className="text-sm hover:underline">
                  Next →
                </Link>
              ) : (
                <span />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
