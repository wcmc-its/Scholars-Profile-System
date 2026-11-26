"use client";

/**
 * MethodFamilyPicker — the "Methods this service supports" field of the Method
 * services editor: a multi-select combobox over the public method families.
 * Type to search (`GET /api/edit/method-families`, debounced); Arrow keys move
 * through the matches, Enter adds the active one, Escape closes the list. Each
 * pick becomes a chip with its own labelled remove button.
 *
 * The same combobox shape as `DirectoryPeopleTypeahead` (the console has no
 * shared combobox primitive), kept separate because that one holds a single
 * person and this one a list of families.
 *
 * Imports only pure helpers and types: nothing here reaches `@/lib/db`.
 */
import * as React from "react";
import { X } from "lucide-react";

import {
  methodFamilyKey,
  type MethodFamilyOption,
  type MethodServiceFamily,
} from "@/lib/method-services/validation";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

export type MethodFamilyPickerProps = {
  /** The `<input>` id, for the field's `<label htmlFor>`. */
  inputId: string;
  value: ReadonlyArray<MethodServiceFamily>;
  onChange: (value: MethodServiceFamily[]) => void;
  disabled?: boolean;
  /** Ids of the hint and error text that describe the field. */
  describedBy?: string;
  invalid?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
};

export function MethodFamilyPicker({
  inputId,
  value,
  onChange,
  disabled = false,
  describedBy,
  invalid = false,
  inputRef,
}: MethodFamilyPickerProps) {
  const listboxId = `${inputId}-listbox`;
  const localRef = React.useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<MethodFamilyOption[]>([]);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const abortRef = React.useRef<AbortController | null>(null);

  const setRefs = (node: HTMLInputElement | null) => {
    localRef.current = node;
    if (typeof inputRef === "function") inputRef(node);
    else if (inputRef) inputRef.current = node;
  };

  // Debounced fetch. A query shorter than the minimum clears the list without
  // hitting the network.
  React.useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      abortRef.current?.abort();
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
        const res = await fetch(`/api/edit/method-families?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        const data = (await res.json().catch(() => null)) as
          | { ok: true; families: MethodFamilyOption[] }
          | { ok: false }
          | null;
        if (!res.ok || !data || data.ok !== true) {
          setResults([]);
          setError(true);
        } else {
          setResults(data.families);
          setError(false);
        }
        // Only while the field still has the focus: an answer that lands after
        // the user has moved on must not open a list nothing would close.
        setOpen(document.activeElement === localRef.current);
        setActiveIndex(-1);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setResults([]);
        setError(true);
        setOpen(document.activeElement === localRef.current);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // A family already picked is not offered again.
  const picked = new Set(value.map(methodFamilyKey));
  const options = results.filter((r) => !picked.has(methodFamilyKey(r)));

  function add(option: MethodFamilyOption) {
    onChange([...value, { supercategory: option.supercategory, familyLabel: option.familyLabel }]);
    setQuery("");
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
  }

  function remove(family: MethodServiceFamily) {
    const key = methodFamilyKey(family);
    onChange(value.filter((f) => methodFamilyKey(f) !== key));
    // The chip's button is gone; the field keeps the focus.
    localRef.current?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      // Never submit the surrounding form from the search box.
      event.preventDefault();
      if (open && activeIndex >= 0 && activeIndex < options.length) add(options[activeIndex]);
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.stopPropagation();
        setOpen(false);
        setActiveIndex(-1);
      }
      return;
    }
    if (options.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (open ? (i + 1) % options.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i <= 0 ? options.length - 1 : i - 1));
    }
  }

  const statusText = !open
    ? ""
    : loading
      ? "Searching…"
      : error
        ? "Search failed. Try again."
        : options.length === 0
          ? "No matching methods."
          : `${options.length} ${options.length === 1 ? "match" : "matches"}.`;

  return (
    <div className="relative" data-slot="method-family-picker">
      <div
        className={cn(
          "border-apollo-border-strong bg-apollo-surface focus-within:ring-apollo-maroon flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 focus-within:ring-2",
          invalid && "border-destructive",
          disabled && "opacity-60",
        )}
      >
        {value.length > 0 && (
          <ul className="flex max-w-full flex-wrap gap-1.5" aria-label="Selected methods">
            {value.map((f) => (
              <li
                key={methodFamilyKey(f)}
                className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-[12.5px]"
              >
                <span className="min-w-0 break-words">{f.familyLabel}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => remove(f)}
                  aria-label={`Remove ${f.familyLabel}`}
                  className="hover:bg-apollo-slate-tint-border focus-visible:ring-apollo-maroon inline-flex size-6 shrink-0 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={setRefs}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          value={query}
          disabled={disabled}
          placeholder={value.length === 0 ? "Search methods…" : ""}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => (options.length > 0 || error) && setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActiveIndex(-1);
          }}
          className="text-foreground placeholder:text-muted-foreground h-7 min-w-[9rem] flex-1 bg-transparent px-1 text-sm outline-none"
        />
      </div>
      <ul
        id={listboxId}
        role="listbox"
        aria-label="Matching methods"
        hidden={!open || options.length === 0}
        className="border-apollo-border-strong bg-apollo-surface absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border shadow-md"
      >
        {options.map((o, i) => (
          <li
            key={methodFamilyKey(o)}
            id={`${listboxId}-opt-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            onMouseDown={(e) => {
              // mousedown (not click) so the pick wins the input's blur.
              e.preventDefault();
              add(o);
            }}
            onMouseEnter={() => setActiveIndex(i)}
            className={cn(
              "flex cursor-pointer flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-3",
              i === activeIndex && "bg-apollo-surface-2",
            )}
          >
            <span>{o.familyLabel}</span>
            <span className="text-muted-foreground text-xs">
              {o.supercategoryLabel}
              {o.scholarCount > 0 &&
                ` · ${o.scholarCount.toLocaleString("en-US")} ${o.scholarCount === 1 ? "scholar" : "scholars"}`}
            </span>
          </li>
        ))}
      </ul>
      {/* Search state, announced: the listbox itself holds only options. */}
      <p
        role="status"
        className={cn(
          "text-[12.5px]",
          error ? "text-destructive" : "text-muted-foreground",
          (!open || options.length > 0) && "sr-only",
        )}
      >
        {statusText}
      </p>
    </div>
  );
}
