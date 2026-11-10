"use client";

/**
 * A GET filter form that submits itself on every control change, so a page
 * whose filters are plain query params (`/edit/reports/7`) re-renders without
 * an Apply click. The `change` event bubbles from any checkbox / select /
 * radio inside to the form, which calls the native `requestSubmit()` — a full
 * navigation to the new query string, exactly what the Apply button did, so
 * the URL stays shareable and the server stays the scope boundary.
 *
 * Progressive enhancement: the caller renders its own submit button as
 * `children`; this island hides it once hydrated (`data-hydrated`) and a no-JS
 * visitor still gets the button. Nothing here reaches `@/lib/db`.
 *
 * While the next page loads, the form dims and says "Updating…" so a change
 * that redraws something off-screen still reads as working. `pageshow` clears
 * it when Back restores the page from the bfcache mid-submit.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export function AutoSubmitForm({
  action,
  className,
  children,
  ...rest
}: {
  action?: string;
  className?: string;
  children: ReactNode;
  /** Lets a control elsewhere on the page join the form (`form="<id>"`). */
  id?: string;
  "data-testid"?: string;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setHydrated(true);
    const reset = (e: PageTransitionEvent) => {
      if (e.persisted) setPending(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  const onChange = (e: FormEvent<HTMLFormElement>) => {
    e.currentTarget.requestSubmit();
  };
  return (
    <form
      method="get"
      action={action}
      className={cn(className, "transition-opacity data-[pending=true]:opacity-60")}
      onChange={onChange}
      onSubmit={() => setPending(true)}
      aria-busy={pending || undefined}
      data-hydrated={hydrated ? "true" : undefined}
      data-pending={pending ? "true" : undefined}
      {...rest}
    >
      {children}
      {pending && (
        <span role="status" className="text-muted-foreground text-sm">
          Updating…
        </span>
      )}
    </form>
  );
}
