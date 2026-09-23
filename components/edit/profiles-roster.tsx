/**
 * The Profiles roster table for `/edit/profiles` (#160 UI follow-up,
 * `self-edit-launch-spec.md` § The Profiles roster). The admin entry point: a
 * searchable, prominence-sorted scholar index whose per-row name links to that
 * scholar's editor. Server-rendered — the filter sidebar is a small client
 * island (`ProfilesFilters`); this component and its data (`loadDataQualityRoster`)
 * carry no client JS otherwise. The Apollo "Profiles" tab chrome wraps it.
 *
 * Formerly two separate surfaces: this roster (Name/Title/Unit/Type/Status) and
 * the standalone Data Quality dashboard (prominence sort, leadership badges,
 * headshot/overview/COI gap tracking). They merged here — the roster kept its
 * superuser-only "View as" action, and gained the
 * dashboard's prominence sort, leadership badges, and headshot/overview gap
 * tracking. COI review did NOT carry over here — it's superuser-only and lives
 * on its own page (`/edit/coi`, `components/edit/coi-roster.tsx`) precisely so
 * this broader-audience page never touches it. See `lib/api/data-quality.ts`.
 *
 * The headshot shows as a real thumbnail (a missing one is a dashed initials
 * circle), so reviewers can spot wrong or bad photos, not just absent ones.
 * Visibility is shown only for the exception (a "Hidden" tag); the
 * "Only profiles hidden from the public" filter lists them all.
 *
 * Authorization is the page's job (superuser-gated; org-unit-admin scope is
 * B3); this component only renders what it's handed.
 */
import Link from "next/link";
import { Download } from "lucide-react";

import {
  ProfilesFilters,
  ProfilesFiltersSheet,
  ProfilesSearch,
} from "@/components/edit/profiles-filters";
import { RosterScholarCell, type RosterCardTitle } from "@/components/edit/roster-hover-card";
import { ViewAsButton } from "@/components/edit/view-as-button";
import { formatRoleCategory } from "@/lib/role-display";
import type {
  DataQualityCounts,
  DataQualityEntry,
  DataQualityFacets,
  DataQualityGapFilter,
  OverviewAgeFilter,
  RankFilter,
} from "@/lib/api/data-quality";

export type ProfilesRosterProps = {
  entries: ReadonlyArray<DataQualityEntry>;
  total: number;
  counts: DataQualityCounts;
  /** Filter-bar facet options (person types + the org-unit hierarchy). */
  facets: DataQualityFacets;
  /** Selected person-type (roleCategory) values. */
  roleCategories: string[];
  /** Selected unit values (`dept:CODE` / `div:CODE` / `center:CODE` / `inst:CODE`). */
  units: string[];
  /** Name / CWID search term. */
  q: string;
  gap: DataQualityGapFilter;
  overviewAge: OverviewAgeFilter;
  includeStudents: boolean;
  hiddenOnly: boolean;
  ranks: RankFilter[];
  /** Current appointments per cwid, for this page's hover cards. */
  titles: Record<string, RosterCardTitle[]>;
  page: number;
  pageSize: number;
  /** Whether the viewer can launch "View as" (impersonation flag on + superuser, #729). */
  canImpersonate: boolean;
  /** The viewer's own cwid — the "View as" button is hidden on their own row. */
  viewerCwid: string;
};

const BASE = "/edit/profiles";

type FilterState = {
  roleCategories: string[];
  units: string[];
  q: string;
  gap: DataQualityGapFilter;
  overviewAge: OverviewAgeFilter;
  includeStudents: boolean;
  hiddenOnly: boolean;
  ranks: RankFilter[];
};

/** Serialize the current filters into a URLSearchParams (repeated `type`/`unit`). */
function filterParams(f: FilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  for (const r of f.roleCategories) p.append("type", r);
  for (const r of f.ranks) p.append("rank", r);
  for (const u of f.units) p.append("unit", u);
  if (f.gap !== "all") p.set("gap", f.gap);
  if (f.overviewAge !== "all") p.set("overviewAge", f.overviewAge);
  if (f.includeStudents) p.set("students", "1");
  if (f.hiddenOnly) p.set("visibility", "hidden");
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

/** The "overview last updated" cell — a date, the imported-seed label, or "Never". */
function overviewUpdated(e: DataQualityEntry): string {
  if (e.overviewUpdatedAt) return formatDate(e.overviewUpdatedAt);
  return e.overviewState === "imported" ? "Imported" : "Never";
}

/** A green ✓ (good) or muted "—" (not checked / n/a). */
function Yes() {
  return <span className="font-semibold text-apollo-green" aria-label="yes">✓</span>;
}
function Gap() {
  return (
    <span className="bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap">
      Missing
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
  includeStudents,
  hiddenOnly,
  ranks,
  titles,
  page,
  pageSize,
  canImpersonate,
  viewerCwid,
}: ProfilesRosterProps) {
  const filters: FilterState = {
    roleCategories,
    units,
    q,
    gap,
    overviewAge,
    includeStudents,
    hiddenOnly,
    ranks,
  };
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  const hasPrev = page > 0;
  const hasNext = end < total;
  const filterProps = {
    facets,
    roleCategories,
    units,
    q,
    gap,
    overviewAge,
    includeStudents,
    hiddenOnly,
    ranks,
  };
  // Rail filters only (search sits above the table); the default "hide students"
  // state is not an active filter.
  const activeFilters =
    roleCategories.length +
    ranks.length +
    units.length +
    (gap !== "all" ? 1 : 0) +
    (overviewAge !== "all" ? 1 : 0) +
    (includeStudents ? 1 : 0) +
    (hiddenOnly ? 1 : 0);
  const gapHref = (g: DataQualityGapFilter) => pageHref({ ...filters, gap: g }, 0);

  return (
    <div data-slot="profiles-roster">
      <h1 className="text-apollo-ink mb-4 text-xl font-bold">Profiles</h1>

      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="hidden lg:block lg:w-64 lg:shrink-0">
          <ProfilesFilters {...filterProps} />
        </aside>

        <div className="min-w-0 flex-1">
          <div className="mb-4">
            <ProfilesSearch q={q} />
          </div>
          <div className="mb-4 lg:hidden">
            <ProfilesFiltersSheet {...filterProps} activeCount={activeFilters} />
          </div>
          {/* Summary chips across the in-scope set (before the gap/age filters);
              the two gaps link to that gap filter. */}
          <div className="text-apollo-ink-2 mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>
              <strong className="text-apollo-ink">{counts.inScope.toLocaleString()}</strong> in scope
            </span>
            <Link href={gapHref("no-headshot")} className="hover:underline" data-testid="profiles-gap-headshot">
              <strong className="text-apollo-ink">{counts.missingHeadshot.toLocaleString()}</strong> no
              headshot
            </Link>
            <Link href={gapHref("no-overview")} className="hover:underline" data-testid="profiles-gap-overview">
              <strong className="text-apollo-ink">{counts.missingOverview.toLocaleString()}</strong> no
              overview
            </Link>
          </div>

          <div className="mb-2 flex items-center justify-between">
            <div className="text-muted-foreground text-sm" data-testid="profiles-result-count">
              {total === 0
                ? "No scholars match these filters."
                : `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`}
            </div>
            {total > 0 && (
              <a
                href={exportHref(filters)}
                className="border-apollo-border-strong text-apollo-ink hover:bg-apollo-surface-2 inline-flex h-8 items-center gap-1.5 rounded-md border bg-white px-3 text-sm font-medium"
                data-testid="profiles-export-link"
              >
                <Download className="text-apollo-icon size-4" aria-hidden />
                Download CSV
              </a>
            )}
          </div>

          <div className="border-apollo-border bg-apollo-surface overflow-x-auto rounded-md border">
            <table className="[&_td]:align-middle w-full text-sm" data-testid="profiles-table">
              <thead className="bg-apollo-surface-2 text-apollo-ink-2 text-left text-xs uppercase">
                <tr>
                  <th className="px-3 py-2">Scholar</th>
                  <th className="px-3 py-2">Person type</th>
                  <th className="px-3 py-2 text-center">Overview</th>
                  <th className="px-3 py-2">Overview updated</th>
                  <th className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="text-apollo-ink">
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-muted-foreground px-3 py-6 text-center">
                      No profiles match your search.
                    </td>
                  </tr>
                ) : (
                  entries.map((e) => (
                    <tr key={e.cwid} className="border-t" data-testid={`roster-row-${e.cwid}`}>
                      <td className="px-3 py-2">
                        <RosterScholarCell
                          cwid={e.cwid}
                          name={e.name}
                          slug={e.slug}
                          editHref={e.editHref}
                          hasHeadshot={e.headshot === "present"}
                          isVisible={e.isVisible}
                          leadership={e.leadership}
                          subtitle={[e.title, e.unit].filter(Boolean).join(" · ") || null}
                          personType={formatRoleCategory(e.roleCategory)}
                          titles={titles[e.cwid] ?? []}
                          hasOverview={e.hasOverview}
                          overviewLabel={
                            e.overviewUpdatedAt
                              ? `Edited ${formatDate(e.overviewUpdatedAt)}`
                              : e.overviewState === "imported"
                                ? "Imported"
                                : null
                          }
                          overviewExcerpt={e.overviewExcerpt ?? null}
                        />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatRoleCategory(e.roleCategory) ?? "—"}</td>
                      <td className="px-3 py-2 text-center">{e.hasOverview ? <Yes /> : <Gap />}</td>
                      <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                        {overviewUpdated(e)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-3">
                          {canImpersonate && e.cwid !== viewerCwid && (
                            <ViewAsButton targetCwid={e.cwid} targetName={e.name} variant="ghost" />
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
