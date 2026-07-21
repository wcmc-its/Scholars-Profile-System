/**
 * The Profiles roster table for `/edit/scholars` (#160 UI follow-up,
 * `self-edit-launch-spec.md` § The Profiles roster). The admin entry point: a
 * searchable scholar index whose per-row name links to that scholar's editor.
 * Server-rendered with a
 * plain GET form (search + status filter + pagination all via query params),
 * so it needs no client JS — consistent with the rest of the server-rendered
 * `/edit/*` surface. The Apollo "Profiles" tab chrome wraps it.
 *
 * Authorization is the page's job (superuser-gated; org-unit-admin scope is
 * B3); this component only renders what it's handed.
 */
import Link from "next/link";

import { ViewAsButton } from "@/components/edit/view-as-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatRoleCategory } from "@/lib/role-display";
import type {
  EditRosterEntry,
  EditRosterStatusFilter,
  RosterFacets,
} from "@/lib/api/edit-roster";

export type ProfilesRosterProps = {
  entries: ReadonlyArray<EditRosterEntry>;
  total: number;
  query: string;
  status: EditRosterStatusFilter;
  /** Selected org-unit filter, raw select value ("dept:CODE" | "div:CODE" |
   *  "center:CODE" | ""). */
  unit: string;
  /** Selected person-type (roleCategory) filter, raw DB value or "". */
  roleCategory: string;
  /** Dropdown option lists for the org-unit + person-type filters. */
  facets: RosterFacets;
  page: number;
  pageSize: number;
  /** Whether the viewer can launch "View as" (impersonation flag on + superuser, #729). */
  canImpersonate: boolean;
  /** The viewer's own cwid — the "View as" button is hidden on their own row. */
  viewerCwid: string;
};

const BASE = "/edit/scholars";

function pageHref(opts: {
  page: number;
  query: string;
  status: EditRosterStatusFilter;
  unit: string;
  roleCategory: string;
}): string {
  const p = new URLSearchParams();
  if (opts.query) p.set("q", opts.query);
  if (opts.status !== "all") p.set("status", opts.status);
  if (opts.unit) p.set("unit", opts.unit);
  if (opts.roleCategory) p.set("type", opts.roleCategory);
  if (opts.page > 0) p.set("page", String(opts.page));
  const qs = p.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

export function ProfilesRoster({
  entries,
  total,
  query,
  status,
  unit,
  roleCategory,
  facets,
  page,
  pageSize,
  canImpersonate,
  viewerCwid,
}: ProfilesRosterProps) {
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  const hasPrev = page > 0;
  const hasNext = (page + 1) * pageSize < total;

  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Profiles</h1>

        {/* GET form — search + status filter, no client JS. */}
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3" data-testid="roster-search-form">
          <div className="flex flex-col gap-1">
            <label htmlFor="roster-q" className="text-muted-foreground text-xs">
              Search name or CWID
            </label>
            <Input
              id="roster-q"
              type="search"
              name="q"
              defaultValue={query}
              placeholder="e.g. Smith or abc1001"
              className="w-64"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="roster-unit" className="text-muted-foreground text-xs">
              Org unit
            </label>
            <select
              id="roster-unit"
              name="unit"
              defaultValue={unit}
              className="border-apollo-border-strong h-9 max-w-[16rem] rounded-md border bg-apollo-surface px-3 text-sm"
            >
              <option value="">All units</option>
              <optgroup label="Departments">
                {facets.departments.map((d) => (
                  <option key={`dept:${d.code}`} value={`dept:${d.code}`}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Divisions">
                {facets.divisions.map((d) => (
                  <option key={`div:${d.code}`} value={`div:${d.code}`}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Centers">
                {facets.centers.map((c) => (
                  <option key={`center:${c.code}`} value={`center:${c.code}`}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="roster-type" className="text-muted-foreground text-xs">
              Person type
            </label>
            <select
              id="roster-type"
              name="type"
              defaultValue={roleCategory}
              className="border-apollo-border-strong h-9 rounded-md border bg-apollo-surface px-3 text-sm"
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
            <label htmlFor="roster-status" className="text-muted-foreground text-xs">
              Visibility
            </label>
            <select
              id="roster-status"
              name="status"
              defaultValue={status}
              className="border-apollo-border-strong h-9 rounded-md border bg-apollo-surface px-3 text-sm"
            >
              <option value="all">All</option>
              <option value="visible">Visible</option>
              <option value="hidden">Hidden</option>
            </select>
          </div>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>

        <p className="text-muted-foreground mb-2 text-sm" aria-live="polite">
          {total === 0 ? "No matching profiles." : `Showing ${start}–${end} of ${total.toLocaleString()}`}
        </p>

        <div className="border-apollo-border bg-apollo-surface overflow-hidden rounded-md border">
          <table className="[&_td]:align-middle w-full text-sm">
            <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Unit</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-apollo-border divide-y">
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted-foreground px-3 py-6 text-center">
                    No profiles match your search.
                  </td>
                </tr>
              ) : (
                entries.map((e) => (
                  <tr key={e.cwid} data-testid={`roster-row-${e.cwid}`}>
                    <td className="px-3 py-2">
                      <Link
                        href={`/edit/scholar/${encodeURIComponent(e.cwid)}`}
                        className="text-apollo-slate font-medium hover:underline"
                        data-testid={`roster-name-${e.cwid}`}
                      >
                        {e.name}
                      </Link>{" "}
                      <span className="text-muted-foreground">({e.cwid})</span>
                    </td>
                    <td className="text-muted-foreground px-3 py-2">{e.title ?? "—"}</td>
                    <td className="text-muted-foreground px-3 py-2">{e.unit ?? "—"}</td>
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
              <Link href={pageHref({ page: page - 1, query, status, unit, roleCategory })} className="text-apollo-slate text-sm hover:underline" data-testid="roster-prev">
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            {hasNext ? (
              <Link href={pageHref({ page: page + 1, query, status, unit, roleCategory })} className="text-apollo-slate text-sm hover:underline" data-testid="roster-next">
                Next →
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
    </>
  );
}
