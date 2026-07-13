"use client";

import { Loader2, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import type { EntityKind } from "@/lib/api/search";
import { EntityBadge } from "@/components/ui/entity-badge";
import { reportNavWatchdog, type NavWatchdogSurface } from "@/lib/analytics/nav-watchdog";
import { formatRoleCategory } from "@/lib/role-display";

type Suggestion = {
  kind: EntityKind;
  title: string;
  subtitle?: string;
  href: string;
  cwid?: string;
  roleCategory?: string;
};

type Variant = "header" | "hero";

/**
 * #1017 deploy-cutover skew watchdog. During the ~1-minute window when a new
 * deployment is cutting over, a soft-nav (router.push inside useTransition) can
 * receive an RSC 200 the client neither applies nor hard-reloads: isPending
 * stays true and the URL never moves (the search box spins forever). #931's
 * deployment-skew hard-reload fallback doesn't fire in this window. The
 * watchdog arms a timer on every soft-nav; if, after this delay, we're still
 * pending AND the URL hasn't moved from where the nav started, it forces a hard
 * navigation to the intended href. A successful soft-nav changes the URL (and
 * clears isPending), so the watchdog no-ops — no spurious reload.
 */
const NAV_WATCHDOG_MS = 7000;

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
  // WAI-ARIA 1.2 combobox contract: a stable base id ties the input to the
  // listbox (aria-controls) and the active option (aria-activedescendant),
  // mirroring the edit-side comboboxes (unit-finder / department-picker).
  const reactId = useId();
  const listboxId = `search-ac-${reactId}-listbox`;
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const skipSuggestRef = useRef(false);
  /**
   * #1412 item 4 — resolved prefixes, keyed by the exact typed value. Debounce +
   * AbortController stopped two requests being in flight at once, but nothing remembered a
   * SETTLED answer, so backspacing through a typed query re-fetched every prefix on the
   * way back.
   *
   * Component-scoped, deliberately NOT module-scoped: a module Map is a shared global that
   * outlives every mount, so a prefix resolved once would be pinned for the life of the tab
   * with no TTL — and it silently leaked between test cases, which is how this got caught.
   * The header input stays mounted across soft-navs, so this scope keeps the hit rate that
   * matters (the backspace loop) without the global.
   *
   * ponytail: unbounded within a mount. A session types a bounded number of prefixes —
   * reach for an LRU only if that stops being true.
   */
  const suggestCacheRef = useRef(new Map<string, Suggestion[]>());
  const [isPending, startTransition] = useTransition();

  // #1017 watchdog plumbing. Read the latest isPending from a ref inside the
  // async timer (a captured closure would see a stale value), keep the timer id
  // in a ref so a rapid re-submit clears the prior one, and clear it as soon as
  // the transition resolves so a fast success leaves no lingering timer.
  const isPendingRef = useRef(isPending);
  isPendingRef.current = isPending;
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armNavWatchdog = (href: string, surface: NavWatchdogSurface) => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    const startHref = window.location.href;
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      // Still pending and the URL never moved → the soft-nav hung mid
      // deploy-cutover; force a hard navigation to the intended href.
      if (isPendingRef.current && window.location.href === startHref) {
        // Observe-only telemetry (never blocks the recovery nav) so the firing
        // rate can be tuned — #1017.
        reportNavWatchdog(surface, NAV_WATCHDOG_MS);
        window.location.assign(href);
      }
    }, NAV_WATCHDOG_MS);
  };

  // Clear an armed watchdog the moment the transition resolves (fast success),
  // and on unmount, so no timer fires after the nav already committed.
  useEffect(() => {
    if (!isPending && watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, [isPending]);

  useEffect(() => {
    return () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    };
  }, []);

  useEffect(() => {
    // Skip the suggestion fetch for a programmatic value change (the on-/search
    // pre-fill below), so the dropdown doesn't auto-open on page load.
    if (skipSuggestRef.current) {
      skipSuggestRef.current = false;
      return;
    }
    if (value.trim().length < 2) {
      setSuggestions([]);
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    abortRef.current?.abort();
    // A prefix we have already resolved: serve it and issue no request at all. This is
    // the backspace path — skipping the debounce too, since there is nothing to wait for.
    const cached = suggestCacheRef.current.get(value);
    if (cached) {
      setSuggestions(cached);
      setActiveIndex(-1);
      setOpen(true);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    let ignore = false;
    const timer = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/search/suggest?q=${encodeURIComponent(value)}`, {
          signal: controller.signal,
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as { suggestions: Suggestion[] };
        const next = data.suggestions ?? [];
        // Cache on arrival, not on render — an aborted/superseded response still taught us
        // what that prefix resolves to, and the user may well backspace onto it.
        suggestCacheRef.current.set(value, next);
        if (ignore) return;
        setSuggestions(next);
        setActiveIndex(-1);
        setOpen(true);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }, 150);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
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

  // Pre-fill the box with the active query when landing on /search, so the
  // header search reflects what the user is looking at. Reads window.location
  // directly (client-only) instead of useSearchParams, which the cached header
  // is barred from — it forces a Suspense boundary or `next build` fails to
  // prerender. Mount-only: sets the initial value and intentionally does not
  // chase in-page soft-nav (the header stays mounted across result refinements).
  useEffect(() => {
    if (window.location.pathname !== "/search") return;
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) {
      skipSuggestRef.current = true;
      setValue(q);
    }
  }, []);

  const submit = () => {
    if (value.trim().length === 0) return;
    abortRef.current?.abort();
    setSuggestions([]);
    setOpen(false);
    let href = `/search?q=${encodeURIComponent(value.trim())}`;
    // Preserve the active result tab on a new search instead of bouncing to the
    // Scholars default. Read at submit time (always client) so the header avoids
    // useSearchParams; a fresh query still resets facets/sort/page.
    if (window.location.pathname === "/search") {
      const t = new URLSearchParams(window.location.search).get("type");
      if (t && t !== "people") href += `&type=${encodeURIComponent(t)}`;
    }
    startTransition(() => {
      router.push(href);
    });
    armNavWatchdog(href, "autocomplete_submit"); // #1017
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
        {isPending ? (
          <Loader2
            className={
              isHero ? "ml-3 h-4 w-4 shrink-0 text-zinc-400 animate-spin" : "h-4 w-4 animate-spin"
            }
            aria-hidden="true"
          />
        ) : (
          <Search className={isHero ? "ml-3 h-4 w-4 shrink-0 text-zinc-400" : "h-4 w-4"} />
        )}
        <input
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (activeIndex >= 0 && suggestions[activeIndex]) {
                abortRef.current?.abort();
                setSuggestions([]);
                setOpen(false);
                const suggestionHref = suggestions[activeIndex].href;
                startTransition(() => {
                  router.push(suggestionHref);
                });
                armNavWatchdog(suggestionHref, "autocomplete_suggestion"); // #1017
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
          aria-busy={isPending}
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined
          }
          autoComplete="off"
        />
        {isHero ? (
          <button
            onClick={submit}
            disabled={isPending}
            className="shrink-0 rounded bg-[var(--color-primary-cornell-red)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#951616] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary-cornell-red)] disabled:opacity-70 disabled:cursor-default"
          >
            Search
          </button>
        ) : null}
      </div>
      {open && suggestions.length > 0 ? (
        <ul
          id={listboxId}
          role="listbox"
          className="border-border absolute left-0 right-0 top-full z-30 mt-2 max-h-[60vh] overflow-y-auto overflow-x-hidden rounded-md border bg-background text-left shadow-[0_8px_24px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.08)]"
        >
          {suggestions.map((s, i) => (
            <li
              key={`${s.kind}-${s.href}-${i}`}
              id={`${listboxId}-opt-${i}`}
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
                {s.kind === "person" ? (
                  s.roleCategory ? (
                    <span
                      className="inline-flex shrink-0 items-center rounded-[3px] border border-border bg-muted px-[6px] text-[10px] font-semibold uppercase leading-[1.4] tracking-[0.06em] text-muted-foreground"
                      aria-label={`Role: ${formatRoleCategory(s.roleCategory) ?? s.roleCategory}`}
                    >
                      {formatRoleCategory(s.roleCategory) ?? s.roleCategory}
                    </span>
                  ) : null
                ) : (
                  <EntityBadge kind={s.kind} />
                )}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <span role="status" aria-live="polite" className="sr-only">
        {isPending ? "Searching…" : ""}
      </span>
    </div>
  );
}
