"use client";

/**
 * "Find a method" typeahead in the home Methods section (home refinements
 * mockup, 2026-09-24). Subareas then method families from
 * `/api/search/suggest-methods`; ↑↓ / Enter / Esc; the footer row goes to a
 * full search for the typed text. WAI-ARIA 1.2 combobox, like the hero box.
 *
 * ponytail: Enter hard-navigates (location.assign) rather than router.push, so
 * it needs none of the hero box's hung-soft-nav watchdog (#1995). Clicks are
 * plain links.
 */
import { Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { EntityBadge } from "@/components/ui/entity-badge";
import type { EntitySuggestion } from "@/lib/api/search";

export function MethodFinder() {
  const [value, setValue] = useState("");
  const [results, setResults] = useState<EntitySuggestion[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const cache = useRef(new Map<string, EntitySuggestion[]>());
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const q = value.trim();
  useEffect(() => {
    if (q.length < 2) {
      setResults(null);
      return;
    }
    const hit = cache.current.get(q);
    if (hit) {
      setResults(hit);
      setActive(0);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search/suggest-methods?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!r.ok) return;
        const next = ((await r.json()) as { suggestions: EntitySuggestion[] }).suggestions ?? [];
        cache.current.set(q, next);
        setResults(next);
        setActive(0);
      } catch {
        // aborted or offline: keep the last results
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const items = results ?? [];
  const seeAllHref = `/search?q=${encodeURIComponent(q)}`;
  const shown = open && q.length >= 2 && results !== null;

  return (
    <div ref={boxRef} className="relative w-full sm:w-80">
      <Search
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
        aria-hidden="true"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && items.length) {
            e.preventDefault();
            setOpen(true);
            setActive((i) => (i + 1) % items.length);
          } else if (e.key === "ArrowUp" && items.length) {
            e.preventDefault();
            setActive((i) => (i - 1 + items.length) % items.length);
          } else if (e.key === "Enter" && q.length >= 2) {
            e.preventDefault();
            window.location.assign(items[active]?.href ?? seeAllHref);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="Find a method, e.g. CRISPR"
        aria-label="Find a method"
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown && items[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        className="border-apollo-border-strong bg-apollo-surface h-9 w-full rounded-md border pr-8 pl-8 text-sm outline-none focus-visible:border-[var(--color-accent-slate)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)]/20"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear"
          onClick={() => {
            setValue("");
            setResults(null);
          }}
          className="text-apollo-slate hover:bg-apollo-surface-2 absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md"
        >
          <X className="size-3.5" strokeWidth={2.5} />
        </button>
      )}
      {shown && (
        <div className="border-apollo-border bg-apollo-surface absolute top-11 right-0 z-30 w-[30rem] max-w-[calc(100vw-3rem)] overflow-hidden rounded-xl border shadow-[0_8px_24px_rgba(34,30,28,0.10),0_1px_3px_rgba(34,30,28,0.06)]">
          <ul id={listId} role="listbox" aria-label="Methods and subareas">
            {items.map((s, i) => (
              <li
                key={s.href}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className="border-apollo-border border-b"
              >
                <Link
                  href={s.href}
                  onMouseEnter={() => setActive(i)}
                  className={`flex items-center gap-4 px-4 py-3 no-underline hover:no-underline ${i === active ? "bg-apollo-surface-2" : ""}`}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <Highlight text={s.title} q={q} />
                    {s.subtitle && <span className="text-muted-foreground truncate text-[13px]">{s.subtitle}</span>}
                  </span>
                  <EntityBadge kind={s.kind} />
                </Link>
              </li>
            ))}
          </ul>
          {items.length === 0 && (
            <p className="text-muted-foreground border-apollo-border border-b px-4 py-3.5 text-sm">
              No method families match &ldquo;{q}&rdquo;.
            </p>
          )}
          <Link
            href={seeAllHref}
            className="bg-apollo-page flex items-center justify-between gap-3 px-4 py-2.5 text-[13px] text-[var(--color-accent-slate)]"
          >
            <span>See all matches for &ldquo;{q}&rdquo; →</span>
            <span className="text-muted-foreground hidden text-[11px] sm:inline">↑↓ to move · Enter to open</span>
          </Link>
        </div>
      )}
    </div>
  );
}

/** Bold the first case-insensitive occurrence of `q` (a tool-name match has none). */
function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <span className="text-foreground text-[15px]">{text}</span>;
  return (
    <span className="text-foreground text-[15px]">
      {text.slice(0, i)}
      <strong className="font-semibold">{text.slice(i, i + q.length)}</strong>
      {text.slice(i + q.length)}
    </span>
  );
}
