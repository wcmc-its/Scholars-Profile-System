"use client";

/**
 * The ORCID queue's filter bar (v2 items 6 and 7): one sticky row of dropdowns
 * — person type, department / division, institution (the shared who-filter
 * facets, `lib/edit/person-filter.ts` values) and how the iD was discovered
 * (`orcid_candidate.source`) — the active selections as removable chips, and
 * "Clear all". The `/edit/orcid-coverage` bar's pattern and popover.
 *
 * Every change navigates to the new `?tab=…&type=…&unit=…&source=…` and the
 * server reloads the list, the tab counts and the sample state under it.
 */
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { FacetPopover, type FacetDef } from "@/app/edit/orcid-coverage/filter-bar";
import type { DataQualityFacets } from "@/lib/api/data-quality";
import {
  EMPTY_ORCID_QUEUE_FILTER,
  ORCID_CANDIDATE_SOURCES,
  ORCID_SOURCE_LABEL,
  orcidQueueHref,
  type OrcidCandidateSource,
  type OrcidQueueFilter,
} from "@/lib/edit/orcid-queue";

const SCOPE = "Narrows the list, the tab counts, the sample and bulk confirm.";

export function OrcidQueueFilterBar({
  facets,
  filter,
  tab,
  basePath,
}: {
  /** null = the facet load failed: only the source filter is offered. */
  facets: DataQualityFacets | null;
  filter: OrcidQueueFilter;
  tab: string;
  basePath: string;
}) {
  const router = useRouter();
  const [sel, setSel] = React.useState<OrcidQueueFilter>(filter);
  const [, startTransition] = React.useTransition();

  const apply = (next: OrcidQueueFilter) => {
    setSel(next);
    startTransition(() => router.replace(orcidQueueHref(basePath, tab, next), { scroll: false }));
  };

  const deptOptions = facets
    ? [
        ...facets.departments,
        ...facets.departments
          .flatMap((d) => d.divisions)
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      ]
    : [];
  const defs: FacetDef[] = [
    ...(facets
      ? [
          {
            key: "type",
            label: "Person type",
            options: facets.roleCategories,
            scope: SCOPE,
          },
          {
            key: "dept",
            label: "Department",
            options: deptOptions,
            search: `Search ${deptOptions.length} departments and divisions`,
            scope: SCOPE,
          },
          {
            key: "inst",
            label: "Institution",
            options: facets.institutions,
            search: `Search ${facets.institutions.length} institutions`,
            scope: SCOPE,
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
      scope: "Scholars with an iD found this way. Bulk confirm takes only those iDs.",
    },
  ];

  const selected = (d: FacetDef): string[] =>
    d.key === "type"
      ? sel.types
      : d.key === "source"
        ? sel.sources
        : sel.units.filter((u) => d.options.some((o) => o.value === u));
  const toggle = (d: FacetDef, value: string) => {
    const flip = <T extends string>(xs: T[], v: T) =>
      (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]).sort();
    if (d.key === "type") return apply({ ...sel, types: flip(sel.types, value) });
    if (d.key === "source")
      return apply({ ...sel, sources: flip(sel.sources, value as OrcidCandidateSource) });
    apply({ ...sel, units: flip(sel.units, value) });
  };
  const clear = (d: FacetDef) => {
    if (d.key === "type") return apply({ ...sel, types: [] });
    if (d.key === "source") return apply({ ...sel, sources: [] });
    const mine = new Set(d.options.map((o) => o.value));
    apply({ ...sel, units: sel.units.filter((u) => !mine.has(u)) });
  };
  const labelOf = (d: FacetDef, v: string) => d.options.find((o) => o.value === v)?.label ?? v;
  const chips = defs.flatMap((d) => selected(d).map((v) => ({ d, v, label: labelOf(d, v) })));

  return (
    <div
      className="bg-apollo-page border-apollo-border sticky top-14 z-20 -mx-6 flex flex-col gap-2.5 border-y px-6 py-3"
      data-testid="orcid-queue-filters"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground mr-0.5 text-[13px]">Filter</span>
        {defs.map((d) => (
          <FacetPopover
            key={d.key}
            def={d}
            selected={selected(d)}
            onToggle={(v) => toggle(d, v)}
            onClear={() => clear(d)}
            valueLabel={(v) => labelOf(d, v)}
            testIdPrefix="orcid-queue-filter"
          />
        ))}
        {chips.length > 0 ? (
          <button
            type="button"
            onClick={() => apply(EMPTY_ORCID_QUEUE_FILTER)}
            className="text-apollo-slate h-[34px] px-1.5 text-[13px]"
            data-testid="orcid-queue-clear-all"
          >
            Clear all
          </button>
        ) : null}
        {facets === null ? (
          <span className="text-muted-foreground text-xs">
            Person type, department and institution filters are unavailable right now.
          </span>
        ) : null}
      </div>
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="orcid-queue-filter-chips">
          {chips.map(({ d, v, label }) => (
            <span
              key={`${d.key}:${v}`}
              className="border-apollo-border-strong bg-apollo-surface inline-flex h-[26px] items-center gap-1 rounded-full border pr-1 pl-2.5 text-[12.5px] whitespace-nowrap"
            >
              <span className="text-muted-foreground">{d.label}</span> {label}
              <button
                type="button"
                onClick={() => toggle(d, v)}
                aria-label={`Remove ${d.label}: ${label}`}
                className="text-muted-foreground hover:bg-apollo-surface-2 hover:text-foreground flex size-5 items-center justify-center rounded-full"
              >
                <X className="size-[11px]" strokeWidth={2.6} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
