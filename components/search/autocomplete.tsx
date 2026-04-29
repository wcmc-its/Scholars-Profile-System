"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Suggestion = { text: string; slug: string };

/**
 * Header search input with autocomplete (spec line 184: fires on 2 chars).
 * Submitting routes to /search?q=<query>; clicking a suggestion routes to
 * the scholar's profile page.
 */
export function SearchAutocomplete() {
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
      return;
    }
    // Debounce + cancel in-flight requests.
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
        setSuggestions(data.suggestions);
        setOpen(true);
      } catch (e) {
        // Ignore aborted requests.
        if ((e as Error).name === "AbortError") return;
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [value]);

  // Close on outside click.
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

  return (
    <div ref={containerRef} className="relative w-full max-w-sm">
      <div className="text-muted-foreground flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm focus-within:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900">
        <Search className="h-4 w-4" />
        <input
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (activeIndex >= 0 && suggestions[activeIndex]) {
                router.push(`/scholars/${suggestions[activeIndex].slug}`);
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
          placeholder="Search scholars"
          className="placeholder:text-muted-foreground flex-1 bg-transparent text-zinc-900 outline-none dark:text-zinc-100"
          aria-label="Search scholars"
          autoComplete="off"
        />
      </div>
      {open && suggestions.length > 0 ? (
        <ul className="border-border absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border bg-background shadow-lg">
          {suggestions.map((s, i) => (
            <li key={`${s.slug}-${i}`}>
              <Link
                href={`/scholars/${s.slug}`}
                className={`block px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                  i === activeIndex ? "bg-zinc-100 dark:bg-zinc-800" : ""
                }`}
                onClick={() => setOpen(false)}
              >
                {s.text}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
