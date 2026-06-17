"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useTransition,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { reportNavWatchdog } from "@/lib/analytics/nav-watchdog";
import { cn } from "@/lib/utils";

/**
 * #1017 deploy-cutover skew watchdog (mirrors components/search/autocomplete.tsx).
 * During the ~1-minute deployment cutover a facet/tab/sort/pagination soft-nav
 * can get an RSC 200 the client never commits: isPending stays true and the URL
 * never moves. #931's deployment-skew hard-reload fallback doesn't fire here.
 * The watchdog arms a timer on every navigate(); if it's still pending and the
 * URL hasn't moved when it fires, it forces a hard navigation to the intended
 * href. A successful soft-nav moves the URL (and clears isPending), so the
 * watchdog no-ops.
 */
const NAV_WATCHDOG_MS = 7000;

/**
 * Shared stale-while-revalidate navigation for /search (issue #294 follow-up
 * #2). One useTransition is shared between every TransitionLink and the
 * results region: facet / sort / pagination clicks run router.push inside the
 * transition, so the current results stay on screen — dimmed and aria-busy —
 * instead of the page blanking. Running the navigation in a transition also
 * makes Next.js skip the loading.tsx fallback for these in-page navigations,
 * so PR 1's skeleton (fresh loads) and this dim-in-place (refinements)
 * compose rather than collide.
 */

type NavigateOptions = { scroll?: boolean };

type SearchTransitionValue = {
  isPending: boolean;
  navigate: (href: string, options?: NavigateOptions) => void;
};

const SearchTransitionContext = createContext<SearchTransitionValue | null>(null);

/**
 * Wraps the /search results region: owns the shared transition and dims its
 * subtree while a navigation is pending.
 */
export function SearchTransitionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // #1017 watchdog plumbing. Read the latest isPending from a ref inside the
  // timer (a captured closure would be stale), keep the timer id in a ref so a
  // rapid re-navigate clears the prior one, and clear it once the transition
  // resolves / on unmount so a fast success leaves no lingering timer.
  const isPendingRef = useRef(isPending);
  isPendingRef.current = isPending;
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // #1069 follow-up — scroll preservation across in-place refinements.
  // `scroll: false` (passed by every facet / sort / mode-tab TransitionLink) is
  // INERT on this page: it suppresses Next's explicit `window.scrollTo`, but the
  // App Router's ScrollAndFocusHandler ALSO calls `<main>.focus()` after the
  // navigation commits, and focusing an off-screen landmark scrolls it back into
  // view — re-jumping the page to the top. (Verified on staging: the reset comes
  // from that `focus()`, not from a `scrollTo`.) We deliberately don't suppress
  // the focus — it's Next-internal a11y behaviour we want to keep for screen
  // readers — so instead we save the scroll offset when a `scroll: false` nav
  // starts and restore it once the transition commits, in the same frame as the
  // focus-scroll (rAF runs before paint, so the restore is flicker-free).
  const restoreYRef = useRef<number | null>(null);
  const prevPendingRef = useRef(isPending);
  useEffect(() => {
    const justSettled = prevPendingRef.current && !isPending;
    prevPendingRef.current = isPending;
    if (!justSettled || restoreYRef.current === null) return;
    const y = restoreYRef.current;
    restoreYRef.current = null;
    requestAnimationFrame(() => window.scrollTo(0, y));
  }, [isPending]);

  const value = useMemo<SearchTransitionValue>(
    () => ({
      isPending,
      navigate: (href, options) => {
        // Arm scroll preservation only for the opt-out-of-scroll refinements
        // (facets / sort / mode tabs). Pagination omits `scroll: false`, so it
        // stays disarmed and keeps the conventional scroll-to-top on page change.
        restoreYRef.current = options?.scroll === false ? window.scrollY : null;
        startTransition(() => {
          router.push(href, options);
        });
        // #1017: arm a hard-navigation fallback for a hung deploy-cutover soft-nav.
        if (watchdogRef.current) clearTimeout(watchdogRef.current);
        const startHref = window.location.href;
        watchdogRef.current = setTimeout(() => {
          watchdogRef.current = null;
          if (isPendingRef.current && window.location.href === startHref) {
            // Observe-only telemetry (never blocks the recovery nav) so the
            // firing rate can be tuned — #1017.
            reportNavWatchdog("search_results", NAV_WATCHDOG_MS);
            window.location.assign(href);
          }
        }, NAV_WATCHDOG_MS);
      },
    }),
    [isPending, router],
  );

  return (
    <SearchTransitionContext.Provider value={value}>
      <div
        aria-busy={isPending}
        className={cn(
          "transition-opacity duration-200 motion-reduce:transition-none",
          isPending && "opacity-70",
        )}
      >
        {children}
      </div>
    </SearchTransitionContext.Provider>
  );
}

type TransitionLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  href: string;
};

/**
 * Drop-in for next/link's <Link> on /search. A plain left-click routes through
 * the shared transition; modified clicks (Cmd/Ctrl/Shift/Alt, middle-click)
 * fall through to the browser's normal navigation. Used outside a
 * SearchTransitionProvider it still navigates — just without shared pending
 * state.
 */
export function TransitionLink({ href, onClick, scroll, ...rest }: TransitionLinkProps) {
  const ctx = useContext(SearchTransitionContext);
  const router = useRouter();

  function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    const options: NavigateOptions | undefined = scroll === false ? { scroll: false } : undefined;
    if (ctx) ctx.navigate(href, options);
    else router.push(href, options);
  }

  return <Link href={href} scroll={scroll} onClick={handleClick} {...rest} />;
}
