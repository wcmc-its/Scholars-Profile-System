/**
 * DepartmentPicker — a typeahead over the (bounded) department list (#540
 * Phase 7, `unit-curation-edit-ui-spec.md` § The create form). Backs the
 * Superuser's "Parent department" field on `/edit/unit/new`.
 *
 * Unlike `DirectoryPeopleTypeahead` (which hits LDAP over the network), the
 * department set is small (~dozens) and is loaded once by the server page, so
 * this filters the provided list in-memory — no fetch, no debounce. Same
 * interaction contract: a chip + clear when selected, a filtering combobox
 * otherwise, with mouse + arrow-key navigation.
 */
"use client";

import * as React from "react";
import { X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type DepartmentOption = { code: string; name: string };

export type DepartmentPickerProps = {
  departments: ReadonlyArray<DepartmentOption>;
  value: DepartmentOption | null;
  onChange: (value: DepartmentOption | null) => void;
  placeholder?: string;
  disabled?: boolean;
  idPrefix?: string;
};

const MAX_SHOWN = 50;

export function DepartmentPicker({
  departments,
  value,
  onChange,
  placeholder = "Search departments…",
  disabled = false,
  idPrefix = "department",
}: DepartmentPickerProps) {
  const reactId = React.useId();
  const listboxId = `${idPrefix}-${reactId}-listbox`;

  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);

  const matches = React.useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const pool = trimmed.length === 0
      ? departments
      : departments.filter(
          (d) => d.name.toLowerCase().includes(trimmed) || d.code.toLowerCase().includes(trimmed),
        );
    return pool.slice(0, MAX_SHOWN);
  }, [departments, query]);

  function select(dept: DepartmentOption) {
    onChange(dept);
    setQuery("");
    setOpen(false);
    setActiveIndex(-1);
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

  if (value) {
    return (
      <div
        className="border-apollo-border-strong bg-apollo-surface flex items-center justify-between gap-2 rounded-md border px-3 py-2"
        data-slot="department-picker-selected"
      >
        <span className="min-w-0 truncate text-sm">
          <span className="font-medium">{value.name}</span>
          <span className="text-muted-foreground"> · {value.code}</span>
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={disabled}
          aria-label={`Clear ${value.name}`}
          data-testid={`${idPrefix}-clear`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative" data-slot="department-picker">
      <Input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setOpen(true)}
        data-testid={`${idPrefix}-input`}
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="border-apollo-border bg-apollo-surface absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border shadow-md"
          data-testid={`${idPrefix}-listbox`}
        >
          {matches.length === 0 ? (
            <li className="text-muted-foreground px-3 py-2 text-sm">No matches</li>
          ) : (
            matches.map((dept, i) => (
              <li
                key={dept.code}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(dept);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                data-testid={`${idPrefix}-option-${dept.code}`}
                className={cn(
                  "cursor-pointer px-3 py-2 text-sm",
                  i === activeIndex ? "bg-apollo-surface-2 text-foreground" : "hover:bg-apollo-surface-2",
                )}
              >
                <span className="font-medium">{dept.name}</span>
                <span className="text-muted-foreground"> · {dept.code}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
