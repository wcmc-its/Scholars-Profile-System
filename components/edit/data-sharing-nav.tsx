"use client";

/**
 * `/edit/data-sharing` soft navigation (2026-09 page revision, PR #2826
 * follow-up). The filter bar, the sortable column headers and the faculty
 * pager used to be plain GET links, so every click was a full page reload that
 * jumped back to the top. These islands keep exactly the same hrefs (the URL
 * stays the only source of filter/sort state: links can be shared, opened in a
 * new tab, and the back button walks the history) but apply them as a
 * client-side `router.push(…, { scroll: false })` inside a transition:
 *
 * - `DataSharingNavProvider` owns the transition. While the new server render
 *   is in flight the current page stays on screen (dimmed via
 *   `DataSharingPendingRegion`) instead of dropping to the loading skeleton.
 * - `SoftLink` is an ordinary `<a href>` that intercepts only a plain primary
 *   click. Modified clicks (new tab/window), non-primary buttons and any
 *   `target` fall through to the browser. Outside a provider it is a plain
 *   link, so the no-JS/pre-hydration behaviour is the old GET link.
 * - `SoftGetForm` does the same for the typed Custom year range form.
 *
 * Props only — never import the report lib or anything that builds prisma
 * here (the manageable-units client-bundle trap in CLAUDE.md).
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useTransition,
  type AnchorHTMLAttributes,
  type FormHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";

type NavContext = { navigate: (href: string) => void; pending: boolean };

const Ctx = createContext<NavContext | null>(null);

/** Resolves a (possibly query-only, e.g. `?tier=US_OPEN` or bare `?`) href
 *  against the current location, returning the same-origin path + query. */
function resolveHref(href: string): string {
  const url = new URL(href, window.location.href);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function DataSharingNavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const navigate = useCallback(
    (href: string) => {
      const target = resolveHref(href);
      startTransition(() => router.push(target, { scroll: false }));
    },
    [router],
  );
  const value = useMemo(() => ({ navigate, pending }), [navigate, pending]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Wraps the report sections: marked busy and dimmed while a filter, sort or
 *  page change is loading, so the old numbers never read as the new ones. */
export function DataSharingPendingRegion({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const pending = useContext(Ctx)?.pending ?? false;
  return (
    <div
      aria-busy={pending}
      data-testid="ds-pending-region"
      className={cn(className, "transition-opacity", pending && "opacity-55")}
    >
      {children}
    </div>
  );
}

/** "Updating…" in the filter bar while a navigation is pending. Always
 *  mounted (empty when idle) so the live region announces the change. */
export function DataSharingPendingStatus({ className }: { className?: string }) {
  const pending = useContext(Ctx)?.pending ?? false;
  return (
    <span role="status" aria-live="polite" className={className} data-testid="ds-pending-status">
      {pending ? "Updating…" : ""}
    </span>
  );
}

function isPlainPrimaryClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return !(
    e.defaultPrevented ||
    e.button !== 0 ||
    e.metaKey ||
    e.ctrlKey ||
    e.shiftKey ||
    e.altKey
  );
}

export function SoftLink({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const ctx = useContext(Ctx);
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (!ctx || rest.target || !isPlainPrimaryClick(e)) return;
        e.preventDefault();
        ctx.navigate(href);
      }}
    />
  );
}

/** Serialises a GET form the way the browser would, minus empty fields (an
 *  untouched year input would otherwise add a noise `yearTo=` to the URL;
 *  `parseDataSharingParams` treats empty and absent the same). */
export function formToQuery(form: HTMLFormElement): string {
  const params = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (typeof value === "string" && value !== "") params.append(name, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "?";
}

export function SoftGetForm({
  onSubmit,
  ...rest
}: Omit<FormHTMLAttributes<HTMLFormElement>, "method" | "action">) {
  const ctx = useContext(Ctx);
  return (
    <form
      {...rest}
      method="get"
      onSubmit={(e) => {
        onSubmit?.(e);
        if (!ctx || e.defaultPrevented) return;
        e.preventDefault();
        const form = e.currentTarget;
        // Close the Custom popover this form lives in.
        form.closest("details")?.removeAttribute("open");
        ctx.navigate(formToQuery(form));
      }}
    />
  );
}
