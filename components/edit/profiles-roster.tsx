/**
 * The Profiles roster table for `/edit/scholars` (#160 UI follow-up,
 * `self-edit-launch-spec.md` § The Profiles roster). The admin entry point: a
 * searchable, prominence-sorted scholar index whose per-row name links to that
 * scholar's editor. Server-rendered — the filter sidebar is a small client
 * island (`ProfilesFilters`); this component and its data (`loadDataQualityRoster`)
 * carry no client JS otherwise. The Apollo "Profiles" tab chrome wraps it.
 *
 * Formerly two separate surfaces: this roster (Name/Title/Unit/Type/Status) and
 * the standalone Data Quality dashboard (prominence sort, leadership badges,
 * headshot/overview/COI gap tracking). They merged here — the roster kept its
 * Status column and its superuser-only "View as" action, and gained the
 * dashboard's prominence sort, leadership badges, and headshot/overview gap
 * tracking. COI review did NOT carry over here — it's superuser-only and lives
 * on its own page (`/edit/coi`, `components/edit/coi-roster.tsx`) precisely so
 * this broader-audience page never touches it. See `lib/api/data-quality.ts`.
 *
 * Authorization is the page's job (superuser-gated; org-unit-admin scope is
 * B3); this component only renders what it's handed.
 */
import Link from "next/link";

import { ProfilesFilters } from "@/components/edit/profiles-filters";
import { ViewAsButton } from "@/components/edit/view-as-button";
import { Badge } from "@/components/ui/badge";
import { formatRoleCategory } from "@/lib/role-display";
import type {
  DataQualityCounts,
  DataQualityEntry,
  DataQualityFacets,
  DataQualityGapFilter,
  OverviewAgeFilter,
} from "@/lib/api/data-quality";

export type ProfilesRosterProps = {
  entries: ReadonlyArray<DataQualityEntry>;
  total: number;
  counts: DataQualityCounts;
  /** Filter-bar facet options (person types + the org-unit hierarchy). */
  facets: DataQualityFacets;
  /** Selected person-type (roleCategory) values. */
  roleCategories: string[];
  /** Selected unit values (`dept:CODE` / `div:CODE` / `center:CODE`). */
  units: string[];
  /** Name / CWID search term. */
  q: string;
  gap: DataQualityGapFilter;
  overviewAge: OverviewAgeFilter;
  includeHidden: boolean;
  page: number;
  pageSize: number;
  /** Whether the viewer can launch "View as" (impersonation flag on + superuser, #729). */
  canImpersonate: boolean;
  /** The viewer's own cwid — the "View as" button is hidden on their own row. */
  viewerCwid: string;
};

const BASE = "/edit/scholars";

type FilterState = {
  roleCategories: string[];
  units: string[];
  q: string;
  gap: DataQualityGapFilter;
  overviewAge: OverviewAgeFilter;
  includeHidden: boolean;
};

/** Serialize the current filters into a URLSearchParams (repeated `type`/`unit`). */
function filterParams(f: FilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  for (const r of f.roleCategories) p.append("type", r);
  for (const u of f.units) p.append("unit", u);
  if (f.gap !== "all") p.set("gap", f.gap);
  if (f.overviewAge !== "all") p.set("overviewAge", f.overviewAge);
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** The "overview last updated" cell — a date, the imported-seed label, or "—". */
function overviewUpdated(e: DataQualityEntry): string {
  if (e.overviewUpdatedAt) return formatDate(e.overviewUpdatedAt);
  return e.overviewState === "imported" ? "Imported" : "—";
}

/** A green ✓ (good) or muted "—" (not checked / n/a). */
function Yes() {
  return <span className="font-semibold text-apollo-green" aria-label="yes">✓</span>;
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

export function ProfilesRoster({
  entries,
  total,
  counts,
  facets,
  roleCategories,
  units,
  q,
  gap,
  overviewAge,
  includeHidden,
  page,
  pageSize,
  canImpersonate,
  viewerCwid,
}: ProfilesRosterProps) {
  const filters: FilterState = { roleCategories, units, q, gap, overviewAge, includeHidden };
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  const hasPrev = page > 0;
  const hasNext = end < total;

  return (
    <div data-slot="profiles-roster">
      <h1 className="mb-4 text-xl font-bold">Profiles</h1>

      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="lg:w-64 lg:shrink-0">
          <ProfilesFilters
            facets={facets}
            roleCategories={roleCategories}
            units={units}
            q={q}
            gap={gap}
            overviewAge={overviewAge}
            includeHidden={includeHidden}
          />
        </aside>

        <div className="min-w-0 flex-1">
          {/* Summary chips across the in-scope set (before the gap/age filters). */}
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
          </div>

          <div className="mb-2 flex items-center justify-between">
            <div className="text-muted-foreground text-sm" data-testid="profiles-result-count">
              {total === 0
                ? "No scholars match these filters."
                : `Showing ${start}–${end} of ${total}`}
            </div>
            {total > 0 && (
              <a
                href={exportHref(filters)}
                className="text-sm hover:underline"
                data-testid="profiles-export-link"
              >
                Download CSV
              </a>
            )}
          </div>

          <div className="border-apollo-border bg-apollo-surface overflow-x-auto rounded-md border">
            <table className="[&_td]:align-middle w-full text-sm" data-testid="profiles-table">
              <thead className="bg-apollo-surface-2 text-muted-foreground text-left text-xs uppercase">
                <tr>
                  <th className="w-12 px-3 py-2">#</th>
                  <th className="px-3 py-2">Scholar</th>
                  <th className="px-3 py-2">Person type</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-center">Headshot</th>
                  <th className="px-3 py-2 text-center">Overview</th>
                  <th className="px-3 py-2">Overview updated</th>
                  <th className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-muted-foreground px-3 py-6 text-center">
                      No profiles match your search.
                    </td>
                  </tr>
                ) : (
                  entries.map((e, i) => (
                    <tr key={e.cwid} className="border-t" data-testid={`roster-row-${e.cwid}`}>
                      <td
                        className="text-muted-foreground px-3 py-2 tabular-nums"
                        title={`Prominence ${e.prominence.toFixed(1)}`}
                      >
                        {page * pageSize + i + 1}
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={e.editHref}
                          className="text-apollo-maroon font-medium hover:underline"
                          data-testid={`roster-name-${e.cwid}`}
                        >
                          {e.name}
                        </Link>{" "}
                        <span className="text-muted-foreground">({e.cwid})</span>
                        {e.leadership && (
                          <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-xs">
                            {e.leadership}
                          </span>
                        )}
                        <div className="text-muted-foreground text-xs">
                          {[e.title, e.unit].filter(Boolean).join(" · ") || e.cwid}
                        </div>
                      </td>
                      <td className="text-muted-foreground px-3 py-2">
                        {formatRoleCategory(e.roleCategory) ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          variant="outline"
                          className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
                        >
                          {e.isVisible ? "Visible" : "Hidden"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {e.headshot === "present" ? <Yes /> : e.headshot === "missing" ? <Gap /> : <Unknown />}
                      </td>
                      <td className="px-3 py-2 text-center">{e.hasOverview ? <Yes /> : <Gap />}</td>
                      <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                        {overviewUpdated(e)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-3">
                          {canImpersonate && e.cwid !== viewerCwid && (
                            <ViewAsButton targetCwid={e.cwid} targetName={e.name} />
                          )}
                        </div>
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
                <Link
                  href={pageHref(filters, page - 1)}
                  className="text-sm hover:underline"
                  data-testid="roster-prev"
                >
                  ← Previous
                </Link>
              ) : (
                <span />
              )}
              {hasNext ? (
                <Link
                  href={pageHref(filters, page + 1)}
                  className="text-sm hover:underline"
                  data-testid="roster-next"
                >
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
