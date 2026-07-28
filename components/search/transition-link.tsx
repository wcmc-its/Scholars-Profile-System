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
 * Hung-navigation watchdog (#1017, #1995; mirrors components/search/autocomplete.tsx).
 * The signature, whatever the cause: a facet/tab/sort/pagination soft-nav gets
 * an RSC 200 the client never commits — the navigation stays pending and the URL
 * never moves. #1017 saw it during the ~1-minute deployment cutover, where
 * #931's deployment-skew hard-reload fallback doesn't fire; #1995 measured the
 * same signature in steady state with no deploy in flight (one RSC fetch that
 * completed in 193-240 ms, zero main-thread long tasks, `history.pushState`
 * never called, still hung at 65 s). So the watchdog keys on the observable
 * signature rather than on a presumed cause: it arms a timer on every
 * navigate(); if the URL still hasn't moved when it fires, it forces a hard
 * navigation to the intended href. A successful soft-nav moves the URL (and
 * clears isPending, which disarms the timer in the effect below), so the
 * watchdog no-ops.
 *
 * This is a MITIGATION, not a cure — it bounds an indefinite hang at a hard
 * reload. The intermittent App Router commit failure behind #1995 is still open.
 *
 * 2500 ms, down from #1017's 7000: the origin answers this navigation in ~0.25 s
 * (measured against prod, #1995), so 2.5 s is ~10x headroom over a healthy round
 * trip.
 */
const NAV_WATCHDOG_MS = 2500;

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

  // #1017 watchdog plumbing. Keep the timer id in a ref so a rapid re-navigate
  // clears the prior one, and clear it once the transition resolves / on unmount
  // so a fast success leaves no lingering timer. That effect-driven disarm is
  // now the only pending signal the watchdog trusts — see the guard below.
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
        // #1017 / #1995: arm a hard-navigation fallback for a soft-nav that
        // never commits. Read the URL BEFORE the push so a navigation that
        // commits promptly can't be mistaken for a frozen one.
        const startHref = window.location.href;
        startTransition(() => {
          router.push(href, options);
        });
        if (watchdogRef.current) clearTimeout(watchdogRef.current);
        watchdogRef.current = setTimeout(() => {
          watchdogRef.current = null;
          // #1995: the guard reads ONLY the BOM. It used to also require an
          // `isPendingRef` written during render, but React writes that ref on
          // renders that never commit, so it read false while the committed DOM
          // still said aria-busy — the watchdog no-opped through the exact hang
          // it exists for (0 recoveries in 4 of 5 observed firings). The
          // [isPending] effect above already disarms this timer when the
          // transition resolves, and effects only run on committed renders, so
          // that is the trustworthy half of the old condition.
          if (window.location.href === startHref) {
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
  /**
   * #1995 experiment (SEARCH_PLAIN_LINK_TABS, server-resolved and threaded in
   * from the /search page). Renders a plain next/link <Link> — the click is left
   * to Next's own handler, so this link never touches the shared transition or
   * router.push. Set only on the three mode tabs; facet / sort / pagination
   * links leave it unset.
   */
  plain?: boolean;
};

/**
 * Drop-in for next/link's <Link> on /search. A plain left-click routes through
 * the shared transition; modified clicks (Cmd/Ctrl/Shift/Alt, middle-click)
 * fall through to the browser's normal navigation. Used outside a
 * SearchTransitionProvider it still navigates — just without shared pending
 * state.
 */
export function TransitionLink({ href, onClick, scroll, plain, ...rest }: TransitionLinkProps) {
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

  return <Link href={href} scroll={scroll} onClick={plain ? onClick : handleClick} {...rest} />;
}
