/**
 * UnitFinder — a typeahead over every org unit, for the Superuser "jump to any
 * unit" affordance on `/edit/units` (#753). A superuser holds no `unit_admin`
 * rows yet may edit any unit, so the index can't enumerate "their" units — this
 * finder is how they reach one.
 *
 * Mirrors `DepartmentPicker`'s interaction contract (in-memory filter over a
 * server-provided bounded list, mouse + arrow-key navigation, no fetch) but
 * acts as navigation rather than form input: selecting an option routes to that
 * unit's editor. The list spans all three kinds, so each row carries a kind tag.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Input } from "@/components/ui/input";
import { unitKindLabel, type UnitFinderEntry } from "@/lib/edit/manageable-units";
import { cn } from "@/lib/utils";

const MAX_SHOWN = 50;

export function UnitFinder({ units }: { units: ReadonlyArray<UnitFinderEntry> }) {
  const router = useRouter();
  const reactId = React.useId();
  const listboxId = `unit-finder-${reactId}-listbox`;

  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);

  const matches = React.useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const pool =
      trimmed.length === 0
        ? units
        : units.filter(
            (u) => u.name.toLowerCase().includes(trimmed) || u.code.toLowerCase().includes(trimmed),
          );
    return pool.slice(0, MAX_SHOWN);
  }, [units, query]);

  function select(unit: UnitFinderEntry) {
    setOpen(false);
    setActiveIndex(-1);
    router.push(unit.href);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (event.key === "ArrowDown") setOpen(true);
      return;
    }
    if (matches.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i <= 0 ? matches.length - 1 : i - 1));
    } else if (event.key === "Enter") {
      if (activeIndex >= 0 && activeIndex < matches.length) {
        event.preventDefault();
        select(matches[activeIndex]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  return (
    <div className="relative" data-slot="unit-finder">
      <Input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label="Find any unit"
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
        value={query}
        placeholder="Find any unit by name or code…"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setOpen(true)}
        data-testid="unit-finder-input"
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="border-apollo-border bg-apollo-surface absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border shadow-md"
          data-testid="unit-finder-listbox"
        >
          {matches.length === 0 ? (
            <li className="text-muted-foreground px-3 py-2 text-sm">No matches</li>
          ) : (
            matches.map((unit, i) => (
              <li
                key={`${unit.kind}:${unit.code}`}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(unit);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                data-testid={`unit-finder-option-${unit.kind}-${unit.code}`}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm",
                  i === activeIndex
                    ? "bg-apollo-surface-2 text-foreground"
                    : "hover:bg-apollo-surface-2",
                )}
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">{unit.name}</span>
                  <span className="text-muted-foreground"> · {unit.code}</span>
                </span>
                <span className="text-muted-foreground flex-none text-xs">
                  {unitKindLabel(unit.kind)}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
