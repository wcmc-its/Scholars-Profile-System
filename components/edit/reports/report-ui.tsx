/**
 * The building blocks the redesigned report bodies share (reports redesign,
 * 2026-09-24; mockups `Pub Reports/*.dc.html`): the filter rail, its
 * collapsible sections, the active-filter chips, the headline numbers, and
 * the white results card. Server-safe (no hooks, no client state), so a body
 * can render them directly; the one client helper, {@link useShowMore}, lives
 * in `report-show-more.ts`.
 *
 * A rail section is a native `<details>`: collapsed, its inputs stay in the
 * DOM, so they still ride the body's GET `AutoSubmitForm` — collapsing a
 * section never drops a filter. Nothing here reads a filter; each body passes
 * the labels, summaries and hrefs it computed.
 */
import * as React from "react";
import Link from "next/link";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/** The rail around a body's filters: "Filters", the reset link, a help line,
 *  then the sections. `resetHref` null → the reset link renders disabled
 *  (nothing to reset). */
export function ReportRail({
  resetHref,
  resetLabel = "Reset to defaults",
  help,
  children,
  className,
  testId = "report-rail",
}: {
  resetHref: string | null;
  resetLabel?: string;
  help?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <aside
      className={cn(
        "bg-apollo-rail border-apollo-rail-border rounded-[var(--apollo-radius-card)] border",
        className,
      )}
      data-testid={testId}
    >
      <div className="flex items-center justify-between px-[18px] pt-3.5 pb-2.5">
        <div className="text-[15px] font-semibold">Filters</div>
        {resetHref === null ? (
          <span className="text-muted-foreground/60 text-xs" aria-disabled="true">
            {resetLabel}
          </span>
        ) : (
          <Link href={resetHref} className="text-muted-foreground hover:text-foreground text-xs">
            {resetLabel}
          </Link>
        )}
      </div>
      {help && <div className="text-muted-foreground px-[18px] pb-3 text-[13px]">{help}</div>}
      {children}
    </aside>
  );
}

/** One rail section: an uppercase label, the current value as the summary
 *  line, a chevron; the controls below when open. */
export function RailSection({
  label,
  summary,
  defaultOpen = false,
  children,
  testId,
}: {
  label: string;
  summary: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <details className="group border-apollo-rail-border border-t" open={defaultOpen} data-testid={testId}>
      <summary className="hover:bg-apollo-rail-hover flex cursor-pointer list-none items-center gap-2.5 px-[18px] py-3 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground block text-xs font-semibold tracking-[0.08em] uppercase">
            {label}
          </span>
          <span className="mt-0.5 block truncate text-sm">{summary}</span>
        </span>
        <span aria-hidden className="text-muted-foreground text-xs transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="flex flex-col gap-3 px-[18px] pt-0.5 pb-4">{children}</div>
    </details>
  );
}

export type FilterChip = {
  group: string;
  value: string;
  /** The URL without this filter; null → a chip with no remove button
   *  (e.g. the year range, which always has a value). */
  removeHref: string | null;
};

/** The active filters as removable pills, above the tabs. */
export function FilterChips({ chips, testId = "report-chips" }: { chips: ReadonlyArray<FilterChip>; testId?: string }) {
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" data-testid={testId}>
      {chips.map((c) => (
        <li
          key={`${c.group}:${c.value}`}
          className="bg-apollo-surface-2 border-apollo-border-strong inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-1.5 pl-2.5 text-[13px]"
        >
          <span className="text-muted-foreground">{c.group}:</span>
          <span>{c.value}</span>
          {c.removeHref !== null && (
            <Link
              href={c.removeHref}
              aria-label={`Remove ${c.group}: ${c.value}`}
              className="text-muted-foreground hover:text-foreground inline-grid size-4 place-items-center rounded-full"
            >
              <X size={12} aria-hidden />
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The headline numbers (e.g. "69 scholars · 86 distinct publications"),
 *  with the download button and its note at the right (`aside`). */
export function ReportStats({
  stats,
  aside,
  testId = "report-stats",
}: {
  stats: ReadonlyArray<{ value: React.ReactNode; label: string }>;
  aside?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-6" data-testid={testId}>
      <dl className="flex flex-wrap gap-x-10 gap-y-4">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col-reverse">
            <dt className="text-muted-foreground text-sm">{s.label}</dt>
            <dd className="text-[40px] leading-none font-bold tracking-[-0.02em] tabular-nums">{s.value}</dd>
          </div>
        ))}
      </dl>
      {aside && <div className="max-w-[340px] min-w-0">{aside}</div>}
    </div>
  );
}

/** The white card the results sit in, beside the rail. */
export function ReportCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        "bg-apollo-surface border-apollo-border min-w-0 rounded-[var(--apollo-radius-card)] border p-6 sm:p-8",
        className,
      )}
    >
      {children}
    </section>
  );
}

/** Rail + results: a 290px rail beside the card on large screens; stacked
 *  (the body puts its rail in `FiltersSheet` for phones) below `lg`. */
export function ReportLayout({ rail, children }: { rail: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-7 grid items-start gap-6 lg:grid-cols-[290px_minmax(0,1fr)]">
      <div className="hidden lg:sticky lg:top-4 lg:block lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">{rail}</div>
      {children}
    </div>
  );
}
