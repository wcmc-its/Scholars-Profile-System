/**
 * AllUnitsDirectory (#971) — the complete, info-rich org-unit listing on
 * `/edit/units`, visible only to superusers + comms stewards (the page gates it;
 * this component renders whatever it's handed). Where "Units you manage" shows
 * the actor's own grants as cards, this is the full org-chart audit view: every
 * department, division, and center with its names, leadership, counts,
 * provenance, and the two curation gaps that matter (no description, no leader).
 *
 * A TABLE, not a card list (Apollo surface language R5): every unit carries the
 * same attributes in the same order, so they are rows. The columns are
 * Unit / Kind / Code / Scholars / Leader / Description — and "Description" is
 * the point of the shape change: a per-card "No description" pill cannot be
 * scanned, so the page's Missing-description filter had no visually verifiable
 * result. As a column it reads down the page in one pass.
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
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ManageableUnitKind, UnitDirectoryEntry } from "@/lib/edit/manageable-units";

type SortKey = "name" | "kind" | "scholars";

const KIND_ORDER: ReadonlyArray<{ kind: ManageableUnitKind; title: string }> = [
  { kind: "department", title: "Departments" },
  { kind: "division", title: "Divisions" },
  { kind: "center", title: "Centers" },
];

/** Unit · Kind · Code · Scholars · Leader · Description — the group header row spans them all. */
const COLUMN_COUNT = 6;

const TH_CLASS =
  "text-muted-foreground px-3 py-2 text-xs font-semibold tracking-wide whitespace-nowrap uppercase";

/**
 * Human label for a unit's data provenance — the raw `source` ("ED", "manual")
 * is internal jargon. ED = the WCM Enterprise Directory feed that seeds most
 * units; "manual" = a unit curated by hand in this app.
 */
function sourceLabel(source: string): string {
  switch (source.toLowerCase()) {
    case "ed":
      return "Enterprise Directory";
    case "manual":
      return "Manually added";
    default:
      return source;
  }
}

function hasNoDescription(u: UnitDirectoryEntry): boolean {
  return !u.description || u.description.trim().length === 0;
}

/**
 * A WCM Enterprise Directory org-unit code (e.g. "N3623") — departments and
 * divisions carry one. Centers use a local slug, which the Web Directory does
 * not resolve, so those codes render as plain text rather than a dead link.
 */
function isOrgUnitCode(code: string): boolean {
  return /^N\d+$/i.test(code);
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
  // Curation-gap filters — narrow to units missing a description and/or a
  // leader. (A missing *official name* is not a gap: it's an occasional curated
  // override, not something every unit should carry.)
  const [missingDescriptionOnly, setMissingDescriptionOnly] = React.useState(false);
  const [missingLeaderOnly, setMissingLeaderOnly] = React.useState(false);

  const filtered = React.useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const pool = units.filter((u) => {
      if (missingDescriptionOnly && !hasNoDescription(u)) return false;
      if (missingLeaderOnly && u.leaderName) return false;
      if (trimmed.length === 0) return true;
      return (
        u.officialName.toLowerCase().includes(trimmed) ||
        u.name.toLowerCase().includes(trimmed) ||
        u.compactName.toLowerCase().includes(trimmed) ||
        u.code.toLowerCase().includes(trimmed) ||
        (u.leaderName?.toLowerCase().includes(trimmed) ?? false)
      );
    });
    if (sort === "scholars") {
      // Most scholars first, as a flat list across kinds so the biggest units
      // lead; ties fall back to name.
      return [...pool].sort(
        (a, b) => b.scholarCount - a.scholarCount || a.officialName.localeCompare(b.officialName),
      );
    }
    // "name" and "kind" both group-render by kind below, so within a group a
    // name sort is the natural order either way.
    return [...pool].sort((a, b) => a.officialName.localeCompare(b.officialName));
  }, [units, query, sort, missingDescriptionOnly, missingLeaderOnly]);

  return (
    <div
      className="flex flex-col gap-4"
      data-slot="all-units-directory"
      data-testid="all-units-directory"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">All units</h2>
          <p className="text-muted-foreground text-sm">
            Every department, division, and center{isSuperuser ? ", including retired ones," : ""}{" "}
            with its names, leadership, and counts — a read-only audit of the full org chart.
          </p>
        </div>
        {/* Create a unit is superuser-only — a comms_steward edits existing units
            but never creates (or deletes) them. */}
        {isSuperuser && (
          <Button asChild variant="apollo" size="sm">
            <Link href="/edit/unit/new" data-testid="all-units-create">
              <Plus className="size-4" aria-hidden />
              Create a unit
            </Link>
          </Button>
        )}
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
            <option value="scholars">Scholars</option>
          </select>
        </label>
        <GapToggle
          active={missingDescriptionOnly}
          onClick={() => setMissingDescriptionOnly((v) => !v)}
          testid="all-units-filter-missing-description"
        >
          Missing description
        </GapToggle>
        <GapToggle
          active={missingLeaderOnly}
          onClick={() => setMissingLeaderOnly((v) => !v)}
          testid="all-units-filter-missing-leader"
        >
          Missing leader
        </GapToggle>
      </div>

      {/* No match renders nothing at all, exactly as the card list did — the
          filter bar above is the only affordance a reader needs at that point,
          and a header-only table reads as a broken one. */}
      {filtered.length === 0 ? null : (
        // The fill step from page (--apollo-page) to table body (--apollo-surface)
        // is never a boundary on its own: the wrapping hairline carries it, and
        // overflow-hidden makes the rounded corners clip the thead + row fills.
        <div className="border-apollo-border bg-apollo-surface overflow-hidden rounded-xl border">
          <div className="overflow-x-auto">
            <table
              className="w-full border-collapse text-left text-sm"
              data-testid="all-units-table"
            >
              <thead className="bg-apollo-surface-2">
                <tr className="border-apollo-border border-b">
                  <th scope="col" className={`${TH_CLASS} w-[34%]`}>
                    Unit
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Kind
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Code
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    Scholars
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Leader
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Description
                  </th>
                </tr>
              </thead>
              {sort === "scholars" ? (
                // Sorting by scholars is deliberately a flat list across kinds,
                // so the biggest units lead — grouping would undo the sort.
                <tbody>
                  {filtered.map((unit) => (
                    <UnitRow key={`${unit.kind}:${unit.code}`} unit={unit} />
                  ))}
                </tbody>
              ) : (
                // One <tbody> per kind, each led by a header row spanning every
                // column — the table equivalent of the old group sections.
                KIND_ORDER.map(({ kind, title }) => {
                  const group = filtered.filter((u) => u.kind === kind);
                  if (group.length === 0) return null;
                  return (
                    <tbody key={kind} data-testid={`all-units-group-${title.toLowerCase()}`}>
                      <tr>
                        <th
                          scope="colgroup"
                          colSpan={COLUMN_COUNT}
                          className="bg-apollo-surface-2 border-apollo-border text-muted-foreground border-y px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                        >
                          {title}
                        </th>
                      </tr>
                      {group.map((unit) => (
                        <UnitRow key={`${unit.kind}:${unit.code}`} unit={unit} />
                      ))}
                    </tbody>
                  );
                })
              )}
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function GapToggle({
  active,
  onClick,
  testid,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testid}
      className={
        active
          ? "border-apollo-slate bg-apollo-slate-tint text-apollo-slate rounded-full border px-3 py-1.5 text-sm font-medium"
          : "border-input text-muted-foreground hover:text-foreground rounded-full border px-3 py-1.5 text-sm"
      }
    >
      {children}
    </button>
  );
}

/**
 * One unit as a row. The row is `relative` so the unit-name `<Link>`'s
 * `after:inset-0` pseudo-element stretches across all six cells — that anchor,
 * not a row handler, is what makes the row clickable (R7).
 */
function UnitRow({ unit }: { unit: UnitDirectoryEntry }) {
  const hasDescription = !hasNoDescription(unit);
  const compactDiffers = unit.compactName !== unit.officialName;
  const typeChip = unit.centerType
    ? unit.centerType === "institute"
      ? "Institute"
      : "Center"
    : unit.category
      ? categoryLabel(unit.category)
      : null;
  // Compact name (when it differs) and provenance are per-unit facts that do not
  // deserve columns of their own — they ride under the name as a muted sub-line.
  const subLine = [compactDiffers ? unit.compactName : null, sourceLabel(unit.source)]
    .filter(Boolean)
    .join(" · ");

  return (
    <tr
      className="border-apollo-border hover:bg-apollo-surface-2 focus-within:outline focus-within:-outline-offset-2 focus-within:outline-apollo-maroon relative border-t focus-within:outline-2"
      data-testid={`all-units-row-${unit.kind}-${unit.code}`}
    >
      <td className="px-3 py-2.5 align-top">
        {/* Parent department rides above the name as a muted eyebrow so a
            division's place in the org chart reads at a glance. */}
        {unit.parentDeptName && (
          <span className="text-muted-foreground block text-xs leading-tight">
            {unit.parentDeptName}
          </span>
        )}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Link
            href={unit.href}
            className="text-foreground font-semibold after:absolute after:inset-0 hover:underline"
            data-testid={`all-units-edit-${unit.kind}-${unit.code}`}
          >
            {unit.officialName}
          </Link>
          {unit.retired && (
            <span
              className="flex-none rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
              data-testid={`all-units-retired-${unit.kind}-${unit.code}`}
            >
              Retired
            </span>
          )}
        </span>
        <span className="text-muted-foreground block text-xs leading-tight">{subLine}</span>
      </td>

      <td className="px-3 py-2.5 align-top whitespace-nowrap">
        <span className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border inline-flex rounded-full border px-2 py-0.5 text-xs font-medium">
          {unit.kindLabel}
        </span>
        {/* Institute / Basic & Clinical / … — the finer qualifier, only when it
            says something the kind badge does not. */}
        {typeChip && typeChip !== unit.kindLabel && (
          <span className="text-muted-foreground mt-0.5 block text-xs">{typeChip}</span>
        )}
      </td>

      <td className="text-muted-foreground px-3 py-2.5 align-top whitespace-nowrap">
        <UnitCodeRef code={unit.code} />
      </td>

      <td
        className="px-3 py-2.5 text-right align-top tabular-nums whitespace-nowrap"
        data-testid={`all-units-scholars-${unit.kind}-${unit.code}`}
      >
        {unit.scholarCount}
      </td>

      <td className="px-3 py-2.5 align-top">
        {unit.leaderName ? (
          <span className="text-foreground">
            {unit.leaderInterim ? "Interim " : ""}
            {unit.leaderName}
          </span>
        ) : (
          // An em dash, not an empty cell — a blank reads as "not rendered yet"
          // rather than "nothing there". Screen readers get the words.
          <span
            className="text-muted-foreground"
            title="No leader"
            data-testid={`all-units-gap-${unit.kind}-${unit.code}-leader`}
          >
            <span aria-hidden>—</span>
            <span className="sr-only">No leader</span>
          </span>
        )}
      </td>

      <td className="px-3 py-2.5 align-top whitespace-nowrap">
        {hasDescription ? (
          // The description text itself is not a column (it is a paragraph, and
          // every row would truncate it) — the check says "present", the tooltip
          // shows it.
          <span
            className="text-apollo-green"
            title={unit.description ?? undefined}
            data-testid={`all-units-has-${unit.kind}-${unit.code}-description`}
          >
            <span aria-hidden>✓</span>
            <span className="sr-only">Has a description</span>
          </span>
        ) : (
          <span
            className="text-apollo-maroon font-medium"
            data-testid={`all-units-gap-${unit.kind}-${unit.code}-description`}
          >
            Missing
          </span>
        )}
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
  if (!isOrgUnitCode(code)) return <>{code}</>;
  return (
    <a
      href={`https://directory.weill.cornell.edu/orgunits/${code}`}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:text-foreground relative z-10 underline underline-offset-2"
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
