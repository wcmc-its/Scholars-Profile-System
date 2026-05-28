/**
 * DirectoryPeopleTypeahead — a reusable LDAP-backed people picker (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § 13). Backs the leader card and the access
 * card's "Add admin" form (and, in later PRs, the roster card + the create
 * form's grant step).
 *
 * Behaviour:
 *   - When `value` is set, render a chip with an `×` to clear — no input.
 *   - Otherwise render a combobox `<input>` that debounces (300 ms) onto
 *     `GET /api/directory/people?q=`, lists matches, and supports mouse +
 *     arrow-key navigation with Enter to select / Escape to close.
 *
 * ARIA: `role="combobox"` + `aria-expanded` + `aria-activedescendant`, and the
 * listbox rows are `role="option"`. Stale fetches are aborted so a slow earlier
 * query can't overwrite a newer result.
 */
"use client";

import * as React from "react";
import { X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type DirectoryValue = {
  cwid: string;
  name: string;
  title: string | null;
};

type DirectoryResult = DirectoryValue & { dept: string | null };

export type DirectoryPeopleTypeaheadProps = {
  value: DirectoryValue | null;
  onChange: (value: DirectoryValue | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Distinguishes multiple typeaheads on one page (test ids + ARIA ids). */
  idPrefix?: string;
};

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

export function DirectoryPeopleTypeahead({
  value,
  onChange,
  placeholder = "Search by name…",
  disabled = false,
  idPrefix = "directory",
}: DirectoryPeopleTypeaheadProps) {
  const reactId = React.useId();
  const listboxId = `${idPrefix}-${reactId}-listbox`;

  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<DirectoryResult[]>([]);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const abortRef = React.useRef<AbortController | null>(null);

  // Debounced fetch. A query shorter than the minimum clears the list without
  // hitting the network.
  React.useEffect(() => {
    if (value) return; // a selection is shown; no search input mounted
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      setError(false);
      return;
    }
    setLoading(true);
    setError(false);
    const handle = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/api/directory/people?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        const data = (await res.json()) as
          | { ok: true; people: DirectoryResult[] }
          | { ok: false; error: string };
        if (!res.ok || data.ok !== true) {
          setResults([]);
          setError(true);
        } else {
          setResults(data.people);
          setError(false);
        }
        setOpen(true);
        setActiveIndex(-1);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setResults([]);
        setError(true);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, value]);

  function select(result: DirectoryResult) {
    onChange({ cwid: result.cwid, name: result.name, title: result.title });
    setQuery("");
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) {
      if (event.key === "ArrowDown" && results.length > 0) setOpen(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (event.key === "Enter") {
      if (activeIndex >= 0 && activeIndex < results.length) {
        event.preventDefault();
        select(results[activeIndex]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  // --- selected state: a chip + clear ---
  if (value) {
    return (
      <div
        className="border-input flex items-center justify-between gap-2 rounded-md border px-3 py-2"
        data-slot="directory-typeahead-selected"
      >
        <span className="min-w-0 truncate text-sm">
          <span className="font-medium">{value.name}</span>
          {value.title && <span className="text-muted-foreground"> · {value.title}</span>}
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

  // --- search state: combobox ---
  return (
    <div className="relative" data-slot="directory-typeahead">
      <Input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined
        }
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => results.length > 0 && setOpen(true)}
        data-testid={`${idPrefix}-input`}
      />
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="border-input bg-popover absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border shadow-md"
          data-testid={`${idPrefix}-listbox`}
        >
          {loading && (
            <li className="text-muted-foreground px-3 py-2 text-sm">Searching…</li>
          )}
          {error && (
            <li className="text-destructive px-3 py-2 text-sm">Search failed</li>
          )}
          {!loading && !error && results.length === 0 && (
            <li className="text-muted-foreground px-3 py-2 text-sm">No matches</li>
          )}
          {!error &&
            results.map((result, i) => (
              <li
                key={result.cwid}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => {
                  // mousedown (not click) so selection wins the input's blur.
                  e.preventDefault();
                  select(result);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                data-testid={`${idPrefix}-option-${result.cwid}`}
                className={cn(
                  "cursor-pointer px-3 py-2 text-sm",
                  i === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
              >
                <span className="font-medium">{result.name}</span>
                {result.title && <span className="text-muted-foreground"> · {result.title}</span>}
                {result.dept && (
                  <span className="text-muted-foreground block text-xs">{result.dept}</span>
                )}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
