/**
 * AllUnitsDirectory (#971) — the complete, info-rich org-unit listing on
 * `/edit/units`, visible only to superusers + comms stewards (the page gates it;
 * this component renders whatever it's handed). Where "Units you manage" shows
 * the actor's own grants in bare rows, this is the full org-chart audit view:
 * every department, division, and center with its curated names, leadership,
 * counts, provenance, and curation-gap markers.
 *
 * A client component for one reason: a small in-memory filter + sort over the
 * bounded list (~50 units), mirroring `UnitFinder`'s "server-provided bounded
 * list, filter in-memory, no fetch" contract. The server page passes only plain
 * `UnitDirectoryEntry` data (all strings/numbers/booleans/null), so the
 * server→client boundary is clean.
 */
"use client";

import * as React from "react";
import { ArrowRight } from "lucide-react";

import { Input } from "@/components/ui/input";
import type { ManageableUnitKind, UnitDirectoryEntry } from "@/lib/edit/manageable-units";

type SortKey = "name" | "kind" | "gaps";

const KIND_ORDER: ReadonlyArray<{ kind: ManageableUnitKind; title: string }> = [
  { kind: "department", title: "Departments" },
  { kind: "division", title: "Divisions" },
  { kind: "center", title: "Centers" },
];

/** A unit is a curation gap when its official name, description, or leader is missing. */
function gapCount(unit: UnitDirectoryEntry): number {
  let n = 0;
  // No curated official override (official resolves to the bare canonical name).
  if (unit.officialName === unit.name) n += 1;
  if (!unit.description || unit.description.trim().length === 0) n += 1;
  if (!unit.leaderName) n += 1;
  return n;
}

export function AllUnitsDirectory({
  units,
  isSuperuser,
}: {
  units: ReadonlyArray<UnitDirectoryEntry>;
  isSuperuser: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>("name");

  const filtered = React.useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const pool =
      trimmed.length === 0
        ? units
        : units.filter(
            (u) =>
              u.officialName.toLowerCase().includes(trimmed) ||
              u.name.toLowerCase().includes(trimmed) ||
              u.compactName.toLowerCase().includes(trimmed) ||
              u.code.toLowerCase().includes(trimmed) ||
              (u.leaderName?.toLowerCase().includes(trimmed) ?? false),
          );
    if (sort === "gaps") {
      // Most-incomplete first; ties fall back to name.
      return [...pool].sort(
        (a, b) => gapCount(b) - gapCount(a) || a.officialName.localeCompare(b.officialName),
      );
    }
    // "name" and "kind" both group-render by kind below, so within a group a
    // name sort is the natural order either way.
    return [...pool].sort((a, b) => a.officialName.localeCompare(b.officialName));
  }, [units, query, sort]);

  return (
    <div
      className="flex flex-col gap-4"
      data-slot="all-units-directory"
      data-testid="all-units-directory"
    >
      <div>
        <h2 className="text-[15px] font-semibold">All units</h2>
        <p className="text-muted-foreground text-sm">
          Every department, division, and center{isSuperuser ? ", including retired ones," : ""}{" "}
          with its curated names, leadership, and counts — a read-only audit of the full org chart.
          Amber tags flag a curation gap.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="text"
          value={query}
          placeholder="Filter by name, code, or leader…"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter all units"
          className="max-w-xs"
          data-testid="all-units-filter"
        />
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="border-input text-foreground h-9 rounded-md border bg-transparent px-2 text-sm"
            data-testid="all-units-sort"
          >
            <option value="name">Name</option>
            <option value="kind">Kind</option>
            <option value="gaps">Curation gaps</option>
          </select>
        </label>
      </div>

      {sort === "gaps" ? (
        <UnitList units={filtered} />
      ) : (
        KIND_ORDER.map(({ kind, title }) => (
          <UnitGroup key={kind} title={title} units={filtered.filter((u) => u.kind === kind)} />
        ))
      )}
    </div>
  );
}

function UnitGroup({ title, units }: { title: string; units: UnitDirectoryEntry[] }) {
  if (units.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid={`all-units-group-${title.toLowerCase()}`}>
      <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">{title}</p>
      <UnitList units={units} />
    </section>
  );
}

function UnitList({ units }: { units: UnitDirectoryEntry[] }) {
  if (units.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {units.map((unit) => (
        <UnitRow key={`${unit.kind}:${unit.code}`} unit={unit} />
      ))}
    </ul>
  );
}

function UnitRow({ unit }: { unit: UnitDirectoryEntry }) {
  const hasDescription = !!unit.description && unit.description.trim().length > 0;
  const noOfficial = unit.officialName === unit.name;
  const compactDiffers = unit.compactName !== unit.officialName;
  const typeChip = unit.centerType
    ? unit.centerType === "institute"
      ? "Institute"
      : "Center"
    : unit.category
      ? categoryLabel(unit.category)
      : null;

  return (
    <li
      className="border-apollo-border bg-apollo-surface flex items-center gap-3 rounded-xl border px-4 py-3.5"
      data-testid={`all-units-row-${unit.kind}-${unit.code}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[15px] font-semibold">{unit.officialName}</span>
          {typeChip && (
            <span className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border flex-none rounded-full border px-2 py-0.5 text-xs font-medium">
              {typeChip}
            </span>
          )}
          {unit.retired && (
            <span
              className="flex-none rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
              data-testid={`all-units-retired-${unit.kind}-${unit.code}`}
            >
              Retired
            </span>
          )}
        </div>
        <div className="text-muted-foreground text-sm">
          {unit.kindLabel} · {unit.code}
          {compactDiffers ? ` · ${unit.compactName}` : ""} · {unit.scholarCount} scholars ·{" "}
          {unit.source}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
          {unit.leaderName ? (
            <span className="text-foreground">
              {unit.leaderInterim ? "Interim " : ""}
              {unit.leaderName}
            </span>
          ) : (
            <GapPill kind={unit.kind} code={unit.code} marker="leader">
              No leader
            </GapPill>
          )}
          {unit.parentDeptName && (
            <span className="text-muted-foreground">in {unit.parentDeptName}</span>
          )}
          {hasDescription ? (
            <span className="text-muted-foreground line-clamp-1 max-w-md truncate">
              {unit.description}
            </span>
          ) : (
            <GapPill kind={unit.kind} code={unit.code} marker="description">
              No description
            </GapPill>
          )}
          {noOfficial && (
            <GapPill kind={unit.kind} code={unit.code} marker="official">
              No official name
            </GapPill>
          )}
        </div>
      </div>
      <div className="flex flex-none items-center gap-4">
        <a
          href={unit.href}
          className="text-apollo-slate inline-flex items-center gap-1 text-sm font-medium whitespace-nowrap"
          data-testid={`all-units-edit-${unit.kind}-${unit.code}`}
        >
          Edit
          <ArrowRight className="size-3.5" aria-hidden />
        </a>
      </div>
    </li>
  );
}

function GapPill({
  kind,
  code,
  marker,
  children,
}: {
  kind: ManageableUnitKind;
  code: string;
  marker: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className="flex-none rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
      data-testid={`all-units-gap-${kind}-${code}-${marker}`}
    >
      {children}
    </span>
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
