"use client";

import * as React from "react";

import { RosterFacet, type FacetOption } from "@/components/center/center-roster-facets";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { formatRoleCategory } from "@/lib/role-display";
import type { PublicationsReportRow } from "@/lib/edit/cancer-center-publications-report";

/**
 * `/edit/reports/3` ("Publications") — the client-island table + Person-type
 * filter rail. Org-unit publications reports plan (2026-08-16): all rows load
 * server-side in one shot (`app/edit/reports/3/page.tsx`); filtering is
 * in-memory, no fetch — the SAME client-island shape `components/edit/
 * reports-index.tsx`'s own `ReportsTable` already proves out (checkboxes,
 * `React.useMemo` filter, `RosterFacet` for the checkbox list), reused rather
 * than the URL-navigating pattern `profiles-filters.tsx` uses elsewhere.
 *
 * "Prominent" (per the plan): Person type sits alone at the top of a rail the
 * same visual weight report `2a`'s "Unit type" rail gets — not tucked behind
 * an overflow toggle.
 *
 * Person type = `Scholar.roleCategory` on a row's CONFIRMED unit-member
 * authors (`PublicationsReportRow.authorRoleCategories`, computed server-side
 * — see that module). A row with no selected role category among its authors
 * is filtered out; with nothing selected, every row shows.
 */

const thClass = "px-3 py-2 font-medium";
const tdClass = "px-3 py-2";

function fmtScore(n: number | null, digits = 1): string {
  return n === null ? "—" : n.toFixed(digits);
}

export function PublicationsReportTable({ rows }: { rows: ReadonlyArray<PublicationsReportRow> }) {
  const [selectedRoles, setSelectedRoles] = React.useState<ReadonlySet<string>>(new Set());

  const roleOptions: FacetOption[] = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      for (const role of new Set(r.authorRoleCategories)) {
        counts.set(role, (counts.get(role) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([value, count]) => ({ value, label: formatRoleCategory(value) ?? value, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [rows]);

  const toggleRole = (value: string) => {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const filteredRows = React.useMemo(() => {
    if (selectedRoles.size === 0) return rows;
    return rows.filter((r) => r.authorRoleCategories.some((rc) => selectedRoles.has(rc)));
  }, [rows, selectedRoles]);

  return (
    <div className="mt-4 grid grid-cols-[220px_1fr] items-start gap-5" data-testid="pubs-report-body">
      <div className="border-apollo-rail-border bg-apollo-rail flex flex-col gap-4 rounded-xl border p-3">
        <RosterFacet
          title="Person type"
          options={roleOptions}
          selected={selectedRoles}
          onToggle={toggleRole}
          collapseAfter={10}
        />
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs" data-testid="pubs-report-filtered-count">
          Showing {filteredRows.length.toLocaleString()} of {rows.length.toLocaleString()} matched publications.
        </p>
        <div className="border-apollo-border bg-apollo-surface overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="pubs-report-table">
            <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
              <tr className="border-apollo-border border-b">
                <th className={thClass}>Publication</th>
                <th className={thClass}>Journal</th>
                <th className={thClass}>Impact score</th>
                <th className={thClass}>Journal IF</th>
                <th className={thClass}>5-yr IF</th>
                <th className={thClass}>Quartile</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <tr
                  key={r.pmid}
                  className="border-apollo-border border-b align-top"
                  data-testid={`pubs-report-row-${r.pmid}`}
                >
                  <td className={tdClass}>
                    <a
                      href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(r.pmid)}/`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {r.title}
                    </a>
                    {r.year === null ? null : (
                      <span className="text-muted-foreground ml-1">({r.year})</span>
                    )}
                    {r.synopsis ? (
                      <p
                        className="text-muted-foreground mt-1 text-xs"
                        data-testid={`pubs-report-synopsis-${r.pmid}`}
                      >
                        {r.synopsis}
                      </p>
                    ) : null}
                  </td>
                  <td className={tdClass}>{r.matchedJournalTitle}</td>
                  <td className={`${tdClass} whitespace-nowrap`}>
                    {r.impactScore === null ? (
                      "—"
                    ) : r.impactJustification ? (
                      <HoverTooltip text={r.impactJustification} wide>
                        <span className="cursor-default underline decoration-dotted">
                          {fmtScore(r.impactScore, 0)}
                        </span>
                      </HoverTooltip>
                    ) : (
                      fmtScore(r.impactScore, 0)
                    )}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap`}>{fmtScore(r.impactScore1)}</td>
                  <td className={`${tdClass} whitespace-nowrap`}>{fmtScore(r.impactScore2)}</td>
                  <td className={`${tdClass} whitespace-nowrap`}>{r.quartile ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filteredRows.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="pubs-report-no-rows">
            No matched publications for the selected person type.
          </p>
        ) : null}
      </div>
    </div>
  );
}
