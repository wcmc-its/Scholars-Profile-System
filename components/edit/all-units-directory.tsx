/**
 * AllUnitsDirectory (#971) — the complete, info-rich org-unit listing on
 * `/edit/units`, visible only to superusers + comms stewards (the page gates it;
 * this component renders whatever it's handed). Where "Units you manage" shows
 * the actor's own grants as cards, this is the full org-chart audit view: every
 * department, division, center and core with its names, leadership, counts,
 * provenance, and the two curation gaps that matter (no description, no leader).
 *
 * Layout (Org Units redesign): a FILTER RAIL on the left (Apollo R4 — one greige
 * unit with its own edge) holding a Gap selector (any / no description / no
 * leader / both) and Kind / Type / Source checkbox facets with counts; beside it
 * the free-text filter, a stats line ("N units · N no description · N no
 * leader") with a Name / Most-scholars sort, and the table. Below `lg` the rail
 * moves into the shared phone `FiltersSheet`.
 *
 * A TABLE, not a card list (Apollo surface language R5): every unit carries the
 * same attributes in the same order, so they are rows. Columns are
 * Unit / Code / Scholars / Leader / Desc. — the kind is the collapsible SECTION
 * a row sits in (Departments, Divisions, Centers, Cores), each section header
 * carrying its count and its own gap tally. Both sorts keep the sections.
 *
 * The whole row is the click target via a STRETCHED ANCHOR (R7): the unit-name
 * cell holds a real `<Link href>` whose `after:absolute after:inset-0`
 * pseudo-element covers the `relative` `<tr>`. No onClick/onKeyDown on the row —
 * cmd-click, middle-click, "copy link", tab focus, and screen-reader link
 * announcement all keep working, which a role="button" row would break. The one
 * other interactive element in a row — the Web Directory code link — carries
 * `relative z-10` so it sits ABOVE the stretched anchor and stays clickable.
 *
 * A client component for one reason: an in-memory filter + sort over the bounded
 * list (~80 units), mirroring `UnitFinder`'s "server-provided bounded list,
 * filter in-memory, no fetch" contract. The server page passes only plain
 * `UnitDirectoryEntry` data (all strings/numbers/booleans/null), so the
 * server→client boundary is clean.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { FiltersSheet } from "@/components/edit/filters-sheet";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { UnitDirectoryEntry, UnitPageKind } from "@/lib/edit/manageable-units";
import { cn } from "@/lib/utils";

type SortKey = "name" | "scholars";
type Gap = "any" | "desc" | "lead" | "both";

const KIND_ORDER: ReadonlyArray<{ kind: UnitPageKind; title: string }> = [
  { kind: "department", title: "Departments" },
  { kind: "division", title: "Divisions" },
  { kind: "center", title: "Centers" },
  { kind: "core", title: "Cores" },
];

/** Unit · Code · Scholars · Leader · Desc. · chevron — a section header spans them all. */
const COLUMN_COUNT = 6;

const TYPE_ORDER = ["Clinical", "Basic", "Basic & Clinical", "Administrative", "Institute"];
const SOURCE_ORDER = [
  "Enterprise Directory",
  "Manually added",
  "Seed",
  "ReciterAI core dictionary",
];

const GAPS: ReadonlyArray<{ key: Gap; label: string }> = [
  { key: "any", label: "Any" },
  { key: "desc", label: "No description" },
  { key: "lead", label: "No leader" },
  { key: "both", label: "Both missing" },
];

const TH_CLASS =
  "text-muted-foreground px-3 py-3 text-xs font-medium tracking-[.08em] whitespace-nowrap uppercase first:pl-5 last:pr-5";

/**
 * Human label for a unit's data provenance — the raw `source` ("ED", "manual",
 * "reciterai-core-dictionary") is internal jargon. ED = the WCM Enterprise
 * Directory feed that seeds most units; "manual" = a unit curated by hand in
 * this app; "seed" = the initial center seed; cores come from ReciterAI's core
 * dictionary.
 */
export function sourceLabel(source: string): string {
  switch (source.toLowerCase()) {
    case "ed":
      return "Enterprise Directory";
    case "manual":
      return "Manually added";
    case "seed":
      return "Seed";
    case "reciterai-core-dictionary":
      return "ReciterAI core dictionary";
    default:
      return source;
  }
}

/** The finer unit type the Type facet filters on — a department's browse
 *  category, or "Institute" for an institute-type center. Null otherwise. */
export function unitTypeLabel(u: UnitDirectoryEntry): string | null {
  if (u.kind === "center") return u.centerType === "institute" ? "Institute" : null;
  return u.category ? categoryLabel(u.category) : null;
}

function hasNoDescription(u: UnitDirectoryEntry): boolean {
  return !u.description || u.description.trim().length === 0;
}

const GAP_TEST: Record<Gap, (u: UnitDirectoryEntry) => boolean> = {
  any: () => true,
  desc: (u) => hasNoDescription(u),
  lead: (u) => !u.leaderName,
  both: (u) => hasNoDescription(u) && !u.leaderName,
};

/**
 * A WCM Enterprise Directory org-unit code (e.g. "N3623") — departments and
 * divisions carry one. Centers use a local slug, which the Web Directory does
 * not resolve, so those codes render as plain text rather than a dead link.
 */
function isOrgUnitCode(code: string): boolean {
  return /^N\d+$/i.test(code);
}

function toggle(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** Facet options in a preferred order, then anything else the data carries. */
function orderedOptions(values: Iterable<string>, preferred: readonly string[]): string[] {
  const present = new Set(values);
  const rest = [...present].filter((v) => !preferred.includes(v)).sort();
  return [...preferred.filter((v) => present.has(v)), ...rest];
}

const fmt = (n: number) => n.toLocaleString("en-US");

type FilterState = {
  gap: Gap;
  kinds: ReadonlySet<string>;
  types: ReadonlySet<string>;
  sources: ReadonlySet<string>;
};

export function AllUnitsDirectory({
  units,
  heading = false,
}: {
  units: ReadonlyArray<UnitDirectoryEntry>;
  /** Render an "All units" heading — the page sets it when the viewer's own
   *  "Units you manage" list sits above, so the two lists stay distinct. */
  heading?: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>("name");
  const [filters, setFilters] = React.useState<FilterState>({
    gap: "any",
    kinds: new Set(),
    types: new Set(),
    sources: new Set(),
  });
  const [closed, setClosed] = React.useState<ReadonlySet<string>>(new Set());

  // Everything but the gap + kind filters: the pool the Gap and Kind counts
  // are computed over, so each count says what clicking it would show.
  const base = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return units.filter((u) => {
      if (filters.types.size && !filters.types.has(unitTypeLabel(u) ?? "")) return false;
      if (filters.sources.size && !filters.sources.has(sourceLabel(u.source))) return false;
      if (!q) return true;
      return [
        u.officialName,
        u.name,
        u.compactName,
        u.code,
        u.leaderName ?? "",
        u.parentDeptName ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [units, query, filters.types, filters.sources]);

  const gapped = base.filter(GAP_TEST[filters.gap]);
  const list = gapped.filter((u) => !filters.kinds.size || filters.kinds.has(u.kind));

  const sections = KIND_ORDER.map(({ kind, title }) => {
    const rows = list.filter((u) => u.kind === kind);
    rows.sort(
      sort === "scholars"
        ? (a, b) => b.scholarCount - a.scholarCount || a.officialName.localeCompare(b.officialName)
        : (a, b) => a.officialName.localeCompare(b.officialName),
    );
    return { kind, title, rows };
  }).filter((s) => s.rows.length > 0);

  const activeCount =
    (filters.gap === "any" ? 0 : 1) +
    filters.kinds.size +
    filters.types.size +
    filters.sources.size;
  const anyFilter = activeCount > 0 || query.length > 0;

  const railProps: FilterRailProps = {
    filters,
    setFilters,
    anyFilter,
    onClear: () => {
      setQuery("");
      setFilters({ gap: "any", kinds: new Set(), types: new Set(), sources: new Set() });
    },
    gapCounts: Object.fromEntries(
      GAPS.map((g) => [g.key, base.filter(GAP_TEST[g.key]).length]),
    ) as Record<Gap, number>,
    kindCounts: Object.fromEntries(
      KIND_ORDER.map((k) => [k.kind, gapped.filter((u) => u.kind === k.kind).length]),
    ),
    typeOptions: orderedOptions(
      units.map((u) => unitTypeLabel(u)).filter((t): t is string => !!t),
      TYPE_ORDER,
    ).map((t) => ({ value: t, count: units.filter((u) => unitTypeLabel(u) === t).length })),
    sourceOptions: orderedOptions(
      units.map((u) => sourceLabel(u.source)),
      SOURCE_ORDER,
    ).map((s) => ({ value: s, count: units.filter((u) => sourceLabel(u.source) === s).length })),
  };

  return (
    <div
      className="flex flex-col gap-4"
      data-slot="all-units-directory"
      data-testid="all-units-directory"
    >
      {heading && <h2 className="text-[15px] font-semibold">All units</h2>}
      <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="hidden lg:sticky lg:top-5 lg:block" data-testid="all-units-rail">
          <FilterRail {...railProps} idPrefix="rail" />
        </aside>

        <section className="flex min-w-0 flex-col gap-3.5">
          <div className="flex items-center gap-2">
            <FiltersSheet activeCount={activeCount} testId="all-units-filters-sheet-trigger">
              <FilterRail {...railProps} idPrefix="sheet" />
            </FiltersSheet>
            <Input
              type="text"
              value={query}
              placeholder="Filter by name, code, or leader…"
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter all units"
              className="bg-apollo-surface h-10"
              data-testid="all-units-filter"
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Stat n={list.length} label="units" testid="all-units-stat-units" />
            <Stat n={list.filter(GAP_TEST.desc).length} label="no description" />
            <Stat n={list.filter(GAP_TEST.lead).length} label="no leader" />
            <div className="ml-auto flex items-center gap-2">
              <span className="text-muted-foreground text-[13px]" id="all-units-sort-label">
                Sort
              </span>
              <div
                role="group"
                aria-labelledby="all-units-sort-label"
                className="bg-apollo-surface-2 border-apollo-border flex rounded-lg border p-[3px]"
              >
                {(
                  [
                    ["name", "Name"],
                    ["scholars", "Most scholars"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={sort === key}
                    onClick={() => setSort(key)}
                    data-testid={`all-units-sort-${key}`}
                    className={cn(
                      "cursor-pointer rounded-md px-[11px] py-1 text-[13px] whitespace-nowrap",
                      sort === key
                        ? "bg-apollo-surface text-foreground shadow-[0_1px_2px_rgba(34,30,28,.12)]"
                        : "text-muted-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* The fill step from page (--apollo-page) to table body (--apollo-surface)
              is carried by the wrapping edge; overflow-hidden clips the header fills
              to the rounded corners. */}
          <div className="border-apollo-border-strong bg-apollo-surface overflow-hidden rounded-[13px] border">
            {sections.length === 0 ? (
              <div
                className="text-muted-foreground p-8 text-center text-sm"
                data-testid="all-units-empty"
              >
                No units match these filters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table
                  className="w-full border-collapse text-left text-sm"
                  data-testid="all-units-table"
                >
                  <thead className="bg-apollo-surface-2">
                    <tr className="border-apollo-border-strong border-b">
                      <th scope="col" className={`${TH_CLASS} w-[42%]`}>
                        Unit
                      </th>
                      <th scope="col" className={`${TH_CLASS} hidden md:table-cell`}>
                        Code
                      </th>
                      <th scope="col" className={`${TH_CLASS} text-right`}>
                        Scholars
                      </th>
                      <th scope="col" className={`${TH_CLASS} hidden sm:table-cell`}>
                        Leader
                      </th>
                      <th scope="col" className={TH_CLASS}>
                        <abbr title="Description" className="no-underline">
                          Desc.
                        </abbr>
                      </th>
                      <th scope="col" className={TH_CLASS}>
                        <span className="sr-only">Open</span>
                      </th>
                    </tr>
                  </thead>
                  {sections.map(({ kind, title, rows }) => {
                    const open = !closed.has(kind);
                    const missing = rows.filter(GAP_TEST.desc).length;
                    const noLeader = rows.filter(GAP_TEST.lead).length;
                    const gapLabel = [
                      missing ? `${fmt(missing)} no description` : null,
                      noLeader ? `${fmt(noLeader)} no leader` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <tbody key={kind} data-testid={`all-units-group-${title.toLowerCase()}`}>
                        <tr>
                          <th
                            scope="colgroup"
                            colSpan={COLUMN_COUNT}
                            className="p-0 text-left font-normal"
                          >
                            <button
                              type="button"
                              aria-expanded={open}
                              onClick={() => setClosed((c) => toggle(c, kind))}
                              data-testid={`all-units-section-${kind}`}
                              className="bg-apollo-page border-apollo-border flex w-full cursor-pointer items-center gap-2.5 border-b px-5 py-2.5 text-left"
                            >
                              <span
                                className="text-muted-foreground w-3 text-center text-sm leading-none"
                                aria-hidden
                              >
                                {open ? "▾" : "▸"}
                              </span>
                              <span className="text-[13px] font-semibold tracking-[.06em] uppercase">
                                {title}
                              </span>
                              <span className="text-muted-foreground text-[13px]">
                                {rows.length}
                              </span>
                              {gapLabel && (
                                <span className="text-muted-foreground ml-auto hidden text-[12.5px] whitespace-nowrap sm:inline">
                                  {gapLabel}
                                </span>
                              )}
                            </button>
                          </th>
                        </tr>
                        {open &&
                          rows.map((unit) => (
                            <UnitRow key={`${unit.kind}:${unit.code}`} unit={unit} />
                          ))}
                      </tbody>
                    );
                  })}
                </table>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ n, label, testid }: { n: number; label: string; testid?: string }) {
  return (
    <span className="text-muted-foreground text-[15px] whitespace-nowrap" data-testid={testid}>
      <span className="text-foreground font-semibold tabular-nums">{fmt(n)}</span> {label}
    </span>
  );
}

type FilterRailProps = {
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  anyFilter: boolean;
  onClear: () => void;
  gapCounts: Record<Gap, number>;
  kindCounts: Record<string, number>;
  typeOptions: Array<{ value: string; count: number }>;
  sourceOptions: Array<{ value: string; count: number }>;
};

/** The filter rail — rendered twice (desktop rail + phone sheet), so every id
 *  carries `idPrefix`. Both copies drive the same parent state. */
function FilterRail({
  filters,
  setFilters,
  anyFilter,
  onClear,
  gapCounts,
  kindCounts,
  typeOptions,
  sourceOptions,
  idPrefix,
}: FilterRailProps & { idPrefix: string }) {
  const groups: ReadonlyArray<{
    label: string;
    field: "kinds" | "types" | "sources";
    items: Array<{ value: string; label: string; count: number }>;
  }> = [
    {
      label: "Kind",
      field: "kinds",
      items: KIND_ORDER.map((k) => ({
        value: k.kind,
        label: k.title,
        count: kindCounts[k.kind] ?? 0,
      })),
    },
    { label: "Type", field: "types", items: typeOptions.map((o) => ({ ...o, label: o.value })) },
    {
      label: "Source",
      field: "sources",
      items: sourceOptions.map((o) => ({ ...o, label: o.value })),
    },
  ];

  return (
    <div className="bg-apollo-rail border-apollo-rail-border flex flex-col gap-[22px] rounded-[13px] border px-5 pt-[18px] pb-5">
      <div className="flex items-baseline justify-between">
        <span className="text-muted-foreground text-xs font-medium tracking-[.12em] uppercase">
          Filters
        </span>
        <button
          type="button"
          onClick={onClear}
          disabled={!anyFilter}
          data-testid={`all-units-clear-${idPrefix}`}
          className={cn(
            "text-[13px] disabled:cursor-default",
            anyFilter ? "text-apollo-slate cursor-pointer" : "text-muted-foreground",
          )}
        >
          Clear
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-[13px]" id={`${idPrefix}-gap-label`}>
          Gap
        </span>
        <div
          role="group"
          aria-labelledby={`${idPrefix}-gap-label`}
          className="bg-apollo-surface border-apollo-border-strong flex flex-col gap-0.5 rounded-lg border p-[3px]"
        >
          {GAPS.map((g) => {
            const active = filters.gap === g.key;
            return (
              <button
                key={g.key}
                type="button"
                aria-pressed={active}
                onClick={() => setFilters((f) => ({ ...f, gap: g.key }))}
                data-testid={`all-units-gap-${g.key}-${idPrefix}`}
                className={cn(
                  "flex cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13.5px]",
                  active ? "bg-apollo-slate-tint text-apollo-slate font-medium" : "text-foreground",
                )}
              >
                <span className="whitespace-nowrap">{g.label}</span>
                <span className="text-muted-foreground text-[12.5px] font-normal tabular-nums">
                  {fmt(gapCounts[g.key])}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {groups.map((group) =>
        group.items.length === 0 ? null : (
          <fieldset key={group.label} className="flex flex-col gap-0.5">
            <legend className="text-muted-foreground mb-1.5 text-xs font-medium tracking-[.12em] whitespace-nowrap uppercase">
              {group.label}
            </legend>
            {group.items.map((item) => {
              const id = `${idPrefix}-${group.field}-${item.value}`.replace(/[^A-Za-z0-9_-]/g, "_");
              return (
                <div key={item.value} className="flex items-center gap-2.5 py-1 text-sm">
                  <Checkbox
                    id={id}
                    checked={filters[group.field].has(item.value)}
                    onCheckedChange={() =>
                      setFilters((f) => ({
                        ...f,
                        [group.field]: toggle(f[group.field], item.value),
                      }))
                    }
                    data-testid={`all-units-facet-${group.field}-${item.value}-${idPrefix}`}
                    className="bg-apollo-surface"
                  />
                  <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                    {item.label}
                  </label>
                  <span className="text-muted-foreground text-[13px] tabular-nums">
                    {fmt(item.count)}
                  </span>
                </div>
              );
            })}
          </fieldset>
        ),
      )}
    </div>
  );
}

/**
 * One unit as a row. The row is `relative` so the unit-name `<Link>`'s
 * `after:inset-0` pseudo-element stretches across every cell — that anchor,
 * not a row handler, is what makes the row clickable (R7).
 */
function UnitRow({ unit }: { unit: UnitDirectoryEntry }) {
  const hasDescription = !hasNoDescription(unit);
  const compactDiffers = unit.compactName !== unit.officialName;
  // Compact name (when it differs), type and provenance are per-unit facts that
  // do not deserve columns of their own — they ride under the name.
  const meta = [
    compactDiffers ? unit.compactName : null,
    unitTypeLabel(unit),
    sourceLabel(unit.source),
  ]
    .filter(Boolean)
    .join(" · ");
  const leader = unit.leaderName
    ? `${unit.leaderInterim ? "Interim " : ""}${unit.leaderName}`
    : null;

  return (
    <tr
      className="border-apollo-border hover:bg-apollo-page focus-within:outline-apollo-maroon relative border-b focus-within:outline-2 focus-within:-outline-offset-2"
      data-testid={`all-units-row-${unit.kind}-${unit.code}`}
    >
      <td className="py-3 pr-3 pl-5 align-middle">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          {/* Parent department leads the name so a division's place in the org
              chart reads at a glance. */}
          {unit.parentDeptName && (
            <span className="text-muted-foreground text-[13px] whitespace-nowrap">
              {unit.parentDeptName} ›
            </span>
          )}
          <Link
            href={unit.href}
            className="text-foreground text-[14.5px] font-medium after:absolute after:inset-0 hover:underline"
            data-testid={`all-units-edit-${unit.kind}-${unit.code}`}
          >
            {unit.officialName}
          </Link>
          {unit.retired && (
            <span
              className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate flex-none rounded-full border px-2 py-0.5 text-xs font-medium"
              data-testid={`all-units-retired-${unit.kind}-${unit.code}`}
            >
              Retired
            </span>
          )}
        </span>
        <span className="text-muted-foreground block text-[12.5px] leading-snug">{meta}</span>
        {/* Phones drop the Leader column; the leader rides under the name instead. */}
        <span className="text-muted-foreground block text-[12.5px] leading-snug sm:hidden">
          {leader ?? "No leader"}
        </span>
      </td>

      <td className="text-muted-foreground hidden max-w-[110px] truncate px-3 py-3 align-middle font-mono text-[12.5px] whitespace-nowrap md:table-cell">
        <UnitCodeRef code={unit.code} />
      </td>

      <td
        className={cn(
          "px-3 py-3 text-right align-middle whitespace-nowrap tabular-nums",
          unit.scholarCount ? "text-foreground" : "text-muted-foreground",
        )}
        data-testid={`all-units-scholars-${unit.kind}-${unit.code}`}
      >
        {fmt(unit.scholarCount)}
      </td>

      <td className="hidden max-w-[240px] truncate px-3 py-3 align-middle sm:table-cell">
        {leader ? (
          <span className="text-foreground">{leader}</span>
        ) : (
          <span
            className="text-muted-foreground"
            data-testid={`all-units-gap-${unit.kind}-${unit.code}-leader`}
          >
            No leader
          </span>
        )}
      </td>

      <td className="px-3 py-3 align-middle whitespace-nowrap">
        {hasDescription ? (
          // The description text itself is not a column (it is a paragraph, and
          // every row would truncate it) — the mark says "present", the tooltip
          // shows it.
          <span
            className="text-apollo-slate text-[13px]"
            title={unit.description ?? undefined}
            data-testid={`all-units-has-${unit.kind}-${unit.code}-description`}
          >
            ✓ Written
          </span>
        ) : (
          <span
            className="bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border rounded-full border px-2.5 py-0.5 text-[12.5px]"
            data-testid={`all-units-gap-${unit.kind}-${unit.code}-description`}
          >
            Missing
          </span>
        )}
      </td>

      <td className="text-apollo-border-strong py-3 pr-5 pl-3 align-middle text-[15px]" aria-hidden>
        ›
      </td>
    </tr>
  );
}

/**
 * The unit code — linked to its WCM Web Directory org-unit page when it is a
 * real org-unit code (departments + divisions), plain text otherwise (centers,
 * whose slug the Web Directory does not resolve). Opens in a new tab: the Web
 * Directory is a separate WCM system, so the edit console stays put.
 *
 * `relative z-10` is LOAD-BEARING: without it the row's stretched anchor
 * (`after:inset-0`) paints over this link and swallows the click, sending the
 * reader to the unit editor instead of the Web Directory.
 */
function UnitCodeRef({ code }: { code: string }) {
  if (!isOrgUnitCode(code)) return <span title={code}>{code}</span>;
  return (
    <a
      href={`https://directory.weill.cornell.edu/orgunits/${code}`}
      target="_blank"
      rel="noopener noreferrer"
      title="Open in the WCM Web Directory"
      className="hover:text-foreground relative z-10 underline decoration-dotted underline-offset-2"
      data-testid={`all-units-code-link-${code}`}
    >
      {code}
    </a>
  );
}

function categoryLabel(category: string): string {
  switch (category) {
    case "mixed":
      return "Basic & Clinical";
    case "basic":
      return "Basic";
    case "administrative":
      return "Administrative";
    case "clinical":
    default:
      return "Clinical";
  }
}
