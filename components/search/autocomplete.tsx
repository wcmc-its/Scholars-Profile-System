"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { EntityKind } from "@/lib/api/search";
import { EntityBadge } from "@/components/ui/entity-badge";

type Suggestion = {
  kind: EntityKind;
  title: string;
  subtitle?: string;
  href: string;
  cwid?: string;
};

type Variant = "header" | "hero";

/**
 * Search input with entity-aware autocomplete (spec line 184: fires on 2 chars).
 * Submitting routes to /search?q=<query>; clicking a suggestion routes to the
 * entity's canonical page.
 *
 * Two visual variants share the same suggestion logic:
 *   - "header" (default): compact, fits the 60px sticky red header bar.
 *   - "hero":             larger input, explicit Search button, sized for the
 *                         centered home-page hero placement.
 */
export function SearchAutocomplete({ variant = "header" }: { variant?: Variant } = {}) {
  const isHero = variant === "hero";
  const router = useRouter();
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (value.trim().length < 2) {
      setSuggestions([]);
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/search/suggest?q=${encodeURIComponent(value)}`, {
          signal: controller.signal,
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as { suggestions: Suggestion[] };
        setSuggestions(data.suggestions ?? []);
        setActiveIndex(-1);
        setOpen(true);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const submit = () => {
    if (value.trim().length === 0) return;
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(value.trim())}`);
  };

  const containerClass = isHero
    ? "relative mx-auto w-full max-w-[600px]"
    : "relative w-full max-w-xl";

  const inputBoxClass = isHero
    ? "flex items-center gap-1 rounded-md border border-zinc-300 bg-white p-1 shadow-sm transition-all focus-within:border-[var(--color-accent-slate)] focus-within:ring-2 focus-within:ring-[var(--color-accent-slate)]/20"
    : "text-muted-foreground flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm focus-within:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900";

  const inputClass = isHero
    ? "flex-1 bg-transparent px-3 py-2.5 text-base text-zinc-900 outline-none placeholder:text-zinc-400"
    : "placeholder:text-muted-foreground flex-1 bg-transparent text-zinc-900 outline-none dark:text-zinc-100";

  return (
    <div ref={containerRef} className={containerClass}>
      <div className={inputBoxClass}>
        <Search className={isHero ? "ml-3 h-4 w-4 shrink-0 text-zinc-400" : "h-4 w-4"} />
        <input
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (activeIndex >= 0 && suggestions[activeIndex]) {
                router.push(suggestions[activeIndex].href);
                setOpen(false);
              } else {
                submit();
              }
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
              setOpen(true);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, -1));
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          placeholder={
            isHero
              ? "Search by name, topic, department, or publication…"
              : "Search by name, topic, department…"
          }
          className={inputClass}
          aria-label="Search scholars"
          autoComplete="off"
        />
        {isHero ? (
          <button
            onClick={submit}
            className="shrink-0 rounded bg-[var(--color-accent-slate)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#1f3b53]"
          >
            Search
          </button>
        ) : null}
      </div>
      {open && suggestions.length > 0 ? (
        <ul
          role="listbox"
          className="border-border absolute left-0 right-0 top-full z-30 mt-2 max-h-[60vh] overflow-y-auto overflow-x-hidden rounded-md border bg-background text-left shadow-[0_8px_24px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.08)]"
        >
          {suggestions.map((s, i) => (
            <li
              key={`${s.kind}-${s.href}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className="border-t border-zinc-100 first:border-t-0 dark:border-zinc-800"
            >
              <Link
                href={s.href}
                className={`flex items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-[#fafaf8] dark:hover:bg-zinc-800 ${
                  i === activeIndex ? "bg-[#f5f3ee] dark:bg-zinc-800" : ""
                }`}
                onClick={() => setOpen(false)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-left font-medium text-zinc-900 dark:text-zinc-100">
                    {s.title}
                  </span>
                  {s.subtitle ? (
                    <span className="block truncate text-left text-xs text-zinc-500">{s.subtitle}</span>
                  ) : null}
                </span>
                <EntityBadge kind={s.kind} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
