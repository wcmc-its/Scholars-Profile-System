/**
 * The in-page help pieces the /edit review queues share: the panel that
 * `QueueIntro` opens (sections of terms) and the read-only notice for a viewer
 * who can open a queue but not decide it.
 *
 * No hooks and no server imports, so a server page and a client queue
 * (`components/edit/orcid-queue.tsx`) can both render these.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** One term in a help panel, with an optional color swatch matching its pill. */
export function QueueTerm({
  term,
  swatch,
  children,
}: {
  term: ReactNode;
  swatch?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {swatch ? (
          <span className={cn("size-2.5 rounded-[3px]", swatch)} aria-hidden="true" />
        ) : null}
        <span className="text-sm font-semibold">{term}</span>
      </div>
      <span className="text-[13.5px] leading-[1.55] text-pretty text-[color:var(--evidence-body)]">
        {children}
      </span>
    </div>
  );
}

/** The card a help panel's sections sit in. */
export function QueueHelpPanel({ children }: { children: ReactNode }) {
  return (
    <div className="border-apollo-border-strong bg-apollo-surface flex max-w-[110ch] flex-col gap-5 rounded-[13px] border px-4 py-4 sm:px-[22px] sm:py-[18px]">
      {children}
    </div>
  );
}

/** A titled group of terms: one column on phones, two from `md`. */
export function QueueHelpSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-muted-foreground m-0 text-[12px] font-semibold tracking-[0.06em] uppercase">
        {title}
      </h2>
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

/** The notice for a viewer who can see a queue but cannot decide it. */
export function ReadOnlyNote({
  children,
  className,
  testId = "queue-read-only-note",
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <p
      role="note"
      className={cn(
        "border-apollo-border-strong bg-apollo-surface-2 m-0 rounded-lg border px-3 py-[9px] text-[13.5px] text-pretty text-[#3a3532]",
        className,
      )}
      data-testid={testId}
    >
      {children}
    </p>
  );
}
