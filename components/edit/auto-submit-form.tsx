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
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

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
  useEffect(() => setHydrated(true), []);
  const onChange = (e: FormEvent<HTMLFormElement>) => {
    e.currentTarget.requestSubmit();
  };
  return (
    <form
      method="get"
      action={action}
      className={className}
      onChange={onChange}
      data-hydrated={hydrated ? "true" : undefined}
      {...rest}
    >
      {children}
    </form>
  );
}
