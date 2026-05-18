"use client";

import {
  createContext,
  useContext,
  useMemo,
  useTransition,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

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

  const value = useMemo<SearchTransitionValue>(
    () => ({
      isPending,
      navigate: (href, options) => {
        startTransition(() => {
          router.push(href, options);
        });
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
