"use client";

/**
 * The ORCID queue's filter bar (v3): search (name, CWID, ORCID iD), then
 * Confidence, Decision, Person type, Department, Institution, How discovered
 * and Possible errors, with every applied filter as one row of removable
 * pills and "Clear all". The `/edit/orcid-coverage` bar's popover.
 *
 * Two kinds of facet. Person type, department / division, institution and how
 * discovered (`lib/edit/person-filter.ts` values, `orcid_candidate.source`)
 * read the person tables, so a change navigates to the new
 * `?type=…&unit=…&source=…` and the server reloads the scholar list.
 * Search, Confidence (the best iD's band), Decision and Possible errors (a
 * different iD on file) run in the browser over the loaded summaries.
 */
import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { FacetPopover, type FacetDef } from "@/components/edit/facet-popover";
import type { DataQualityFacets } from "@/lib/api/data-quality";
import {
  EMPTY_ORCID_QUEUE_FILTER,
  isOrcidQueueBand,
  ORCID_CANDIDATE_SOURCES,
  ORCID_QUEUE_BAND_LABEL,
  ORCID_QUEUE_BANDS,
  ORCID_SOURCE_LABEL,
  orcidQueueHref,
  type OrcidCandidateSource,
  type OrcidQueueBand,
  type OrcidQueueFilter,
  type OrcidQueueSummary,
} from "@/lib/edit/orcid-queue";
import { cn } from "@/lib/utils";

/** The facets that run in the browser. `decision`: open = no decision yet
 *  ("Unassigned"), email = the ETL confirmed an iD from a verified email,
 *  null = any. */
export type OrcidQueueClientFilter = {
  q: string;
  bands: OrcidQueueBand[];
  decision: "open" | "email" | null;
  errorsOnly: boolean;
};

const SERVER_SCOPE = "Narrows the scholar list.";
const DECISION_LABEL = { open: "Unassigned", email: "Confirmed by email" } as const;

export function OrcidQueueFilterBar({
  facets,
  filter,
  basePath,
  view,
  onView,
  summaries,
}: {
  /** null = the facet load failed: only the source filter is offered. */
  facets: DataQualityFacets | null;
  filter: OrcidQueueFilter;
  basePath: string;
  view: OrcidQueueClientFilter;
  onView: (v: OrcidQueueClientFilter) => void;
  /** For the Confidence, Decision and Possible errors counts. */
  summaries: OrcidQueueSummary[];
}) {
  const router = useRouter();
  const [sel, setSel] = React.useState<OrcidQueueFilter>(filter);
  const [, startTransition] = React.useTransition();

  const apply = (next: OrcidQueueFilter) => {
    setSel(next);
    startTransition(() => router.replace(orcidQueueHref(basePath, next), { scroll: false }));
  };

  const count = (pred: (s: OrcidQueueSummary) => boolean) => summaries.filter(pred).length;
  const deptOptions = facets
    ? [
        ...facets.departments,
        ...facets.departments
          .flatMap((d) => d.divisions)
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      ]
    : [];
  const confidence: FacetDef = {
    key: "conf",
    label: "Confidence",
    options: ORCID_QUEUE_BANDS.map((b) => ({
      value: b,
      label: ORCID_QUEUE_BAND_LABEL[b],
      count: count((s) => s.candidates[0]?.band === b),
    })),
    scope: "The scholar's best iD.",
  };
  const decision: FacetDef = {
    key: "dec",
    label: "Decision",
    single: true,
    options: [
      { value: "all", label: "Any status", count: summaries.length },
      { value: "open", label: DECISION_LABEL.open, count: count((s) => !s.autoConfirmed) },
      { value: "email", label: DECISION_LABEL.email, count: count((s) => s.autoConfirmed) },
    ],
    scope: "Unassigned: no decision yet.",
  };
  const serverDefs: FacetDef[] = [
    ...(facets
      ? [
          {
            key: "type",
            label: "Person type",
            options: facets.roleCategories,
            scope: SERVER_SCOPE,
          },
          {
            key: "dept",
            label: "Department",
            options: deptOptions,
            search: `Search ${deptOptions.length} departments and divisions`,
            scope: SERVER_SCOPE,
          },
          {
            key: "inst",
            label: "Institution",
            options: facets.institutions,
            search: `Search ${facets.institutions.length} institutions`,
            scope: SERVER_SCOPE,
          },
        ]
      : []),
    {
      key: "source",
      label: "How discovered",
      options: ORCID_CANDIDATE_SOURCES.map((s) => ({
        value: s,
        label: ORCID_SOURCE_LABEL[s],
        count: -1,
      })),
      scope: "Scholars with an iD found this way.",
    },
  ];

  const serverSelected = (d: FacetDef): string[] =>
    d.key === "type"
      ? sel.types
      : d.key === "source"
        ? sel.sources
        : sel.units.filter((u) => d.options.some((o) => o.value === u));
  const flip = <T extends string>(xs: T[], v: T) =>
    (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]).sort();
  const toggleServer = (d: FacetDef, value: string) => {
    if (d.key === "type") return apply({ ...sel, types: flip(sel.types, value) });
    if (d.key === "source")
      return apply({ ...sel, sources: flip(sel.sources, value as OrcidCandidateSource) });
    apply({ ...sel, units: flip(sel.units, value) });
  };
  const clearServer = (d: FacetDef) => {
    if (d.key === "type") return apply({ ...sel, types: [] });
    if (d.key === "source") return apply({ ...sel, sources: [] });
    const mine = new Set(d.options.map((o) => o.value));
    apply({ ...sel, units: sel.units.filter((u) => !mine.has(u)) });
  };
  const labelOf = (d: FacetDef, v: string) => d.options.find((o) => o.value === v)?.label ?? v;

  const pills: Array<{ key: string; label: string; value: string; clear: () => void }> = [
    ...(view.q.trim()
      ? [
          {
            key: "q",
            label: "Search",
            value: `“${view.q.trim()}”`,
            clear: () => onView({ ...view, q: "" }),
          },
        ]
      : []),
    ...(view.decision
      ? [
          {
            key: "dec",
            label: "Decision",
            value: DECISION_LABEL[view.decision],
            clear: () => onView({ ...view, decision: null }),
          },
        ]
      : []),
    ...view.bands.map((b) => ({
      key: `conf:${b}`,
      label: "Confidence",
      value: ORCID_QUEUE_BAND_LABEL[b],
      clear: () => onView({ ...view, bands: view.bands.filter((x) => x !== b) }),
    })),
    ...(view.errorsOnly
      ? [
          {
            key: "err",
            label: "Show",
            value: "Possible errors",
            clear: () => onView({ ...view, errorsOnly: false }),
          },
        ]
      : []),
    ...serverDefs.flatMap((d) =>
      serverSelected(d).map((v) => ({
        key: `${d.key}:${v}`,
        label: d.label,
        value: labelOf(d, v),
        clear: () => toggleServer(d, v),
      })),
    ),
  ];
  const errors = count((s) => s.conflict);

  return (
    <div
      className="border-apollo-border -mx-6 flex flex-col gap-2.5 border-y px-6 py-3"
      data-testid="orcid-queue-filters"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="border-apollo-border-strong bg-apollo-surface flex h-[34px] w-full max-w-[280px] items-center gap-2 rounded-lg border px-2.5">
          <Search className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          <input
            type="search"
            value={view.q}
            onChange={(e) => onView({ ...view, q: e.target.value })}
            placeholder="Name, CWID or ORCID iD"
            aria-label="Search by name, CWID or ORCID iD"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none"
            data-testid="orcid-queue-search"
          />
        </label>
        <span className="text-muted-foreground mx-0.5 text-[13px]">Filter</span>
        <FacetPopover
          def={confidence}
          selected={view.bands}
          onToggle={(v) => isOrcidQueueBand(v) && onView({ ...view, bands: flip(view.bands, v) })}
          onClear={() => onView({ ...view, bands: [] })}
          valueLabel={(v) => labelOf(confidence, v)}
          testIdPrefix="orcid-queue-filter"
        />
        <FacetPopover
          def={decision}
          selected={view.decision ? [view.decision] : []}
          onToggle={(v) => onView({ ...view, decision: v === "open" || v === "email" ? v : null })}
          onClear={() => onView({ ...view, decision: null })}
          valueLabel={(v) => labelOf(decision, v)}
          testIdPrefix="orcid-queue-filter"
        />
        {serverDefs.map((d) => (
          <FacetPopover
            key={d.key}
            def={d}
            selected={serverSelected(d)}
            onToggle={(v) => toggleServer(d, v)}
            onClear={() => clearServer(d)}
            valueLabel={(v) => labelOf(d, v)}
            testIdPrefix="orcid-queue-filter"
          />
        ))}
        <button
          type="button"
          aria-pressed={view.errorsOnly}
          onClick={() => onView({ ...view, errorsOnly: !view.errorsOnly })}
          className={cn(
            "bg-apollo-surface inline-flex h-[34px] items-center rounded-lg border px-3 text-[13.5px] whitespace-nowrap",
            view.errorsOnly ? "border-apollo-slate" : "border-apollo-border-strong",
          )}
          title="Scholars with a different iD already on file"
          data-testid="orcid-queue-filter-errors"
        >
          Possible errors · {errors.toLocaleString("en-US")}
        </button>
        {facets === null ? (
          <span className="text-muted-foreground text-xs">
            Person type, department and institution filters are unavailable right now.
          </span>
        ) : null}
      </div>
      {pills.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="orcid-queue-filter-chips">
          {pills.map((p) => (
            <span
              key={p.key}
              className="border-apollo-slate-tint-border bg-apollo-slate-tint inline-flex h-[28px] items-center gap-1.5 rounded-full border pr-1 pl-3 text-[13px] whitespace-nowrap"
            >
              <span className="text-muted-foreground">{p.label}</span>
              <span className="text-apollo-slate font-semibold">{p.value}</span>
              <button
                type="button"
                onClick={p.clear}
                aria-label={`Remove ${p.label}: ${p.value}`}
                className="text-muted-foreground hover:bg-apollo-surface hover:text-foreground flex size-5 items-center justify-center rounded-full"
              >
                <X className="size-[11px]" strokeWidth={2.6} aria-hidden />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => {
              onView({ q: "", bands: [], decision: null, errorsOnly: false });
              if (
                pills.some(
                  (p) => !["q", "dec", "err"].includes(p.key) && !p.key.startsWith("conf:"),
                )
              )
                apply(EMPTY_ORCID_QUEUE_FILTER);
            }}
            className="text-foreground h-[28px] px-2 text-[13px]"
            data-testid="orcid-queue-clear-all"
          >
            Clear all
          </button>
        </div>
      ) : null}
    </div>
  );
}
