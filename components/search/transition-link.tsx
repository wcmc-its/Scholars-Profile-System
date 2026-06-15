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

  const value = useMemo<SearchTransitionValue>(
    () => ({
      isPending,
      navigate: (href, options) => {
        startTransition(() => {
          router.push(href, options);
        });
        // #1017: arm a hard-navigation fallback for a hung deploy-cutover soft-nav.
        if (watchdogRef.current) clearTimeout(watchdogRef.current);
        const startHref = window.location.href;
        watchdogRef.current = setTimeout(() => {
          watchdogRef.current = null;
          if (isPendingRef.current && window.location.href === startHref) {
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
