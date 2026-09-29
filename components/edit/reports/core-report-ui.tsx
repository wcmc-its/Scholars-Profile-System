/**
 * Pieces the three core-only report bodies (11 Core users, 12 Output over
 * time, 13 Grants citing the core) share on top of `report-ui.tsx`: the tab
 * links, the horizontal bar list (the mockup's By year / By department / By
 * funder), the radio group for a rail section, and the download button with
 * its note. Server-safe: no hooks, no state. A bar that has items is a native
 * `<details>`, so "click a year to see its papers" needs no client code.
 */
import * as React from "react";
import Link from "next/link";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const RADIO = "flex cursor-pointer items-center gap-2 text-sm";
export const RADIO_INPUT = "accent-apollo-maroon size-4";
export const SELECT =
  "border-apollo-border-strong bg-apollo-surface h-[34px] min-w-0 rounded-md border px-2 text-sm";

/** The hidden inputs that keep a core addressed across a filter submit. */
export function CoreScopeInputs({ coreId, view }: { coreId: string; view?: string }) {
  return (
    <>
      <input type="hidden" name="center" value={coreId} />
      <input type="hidden" name="kind" value="core" />
      {view && <input type="hidden" name="view" value={view} />}
    </>
  );
}

export function CoreTabs({
  tabs,
  testId,
}: {
  tabs: ReadonlyArray<{ key: string; label: string; href: string; current: boolean }>;
  testId: string;
}) {
  return (
    <nav
      className="border-apollo-border mt-6 flex flex-wrap gap-x-7 border-b"
      aria-label="Report views"
      data-testid={testId}
    >
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.current ? "page" : undefined}
          data-testid={`${testId}-${t.key}`}
          className={cn(
            "-mb-px border-b-2 py-2.5 text-base whitespace-nowrap",
            t.current
              ? "border-apollo-maroon text-foreground font-semibold"
              : "text-muted-foreground hover:text-foreground border-transparent",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export type Bar = {
  key: string;
  label: string;
  /** e.g. "12" or "12 · 40". */
  value: string;
  /** 0..1 of the widest bar. */
  fraction: number;
  tag?: string;
  muted?: boolean;
  /** Given → the bar expands to show these. */
  items?: React.ReactNode;
};

export function BarList({
  head,
  valueHead,
  bars,
  testId,
}: {
  head: string;
  valueHead: string;
  bars: ReadonlyArray<Bar>;
  testId: string;
}) {
  const row = (b: Bar, chevron: boolean) => (
    <div className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-3 py-1.5 text-sm">
      <span className="flex min-w-0 items-center gap-1.5">
        {chevron && (
          <span
            aria-hidden
            className="text-muted-foreground text-xs transition-transform group-open:rotate-90"
          >
            ›
          </span>
        )}
        <span className="truncate">{b.label}</span>
        {b.tag && (
          <span className="bg-apollo-surface-2 text-muted-foreground rounded px-1 text-[11px] font-semibold">
            {b.tag}
          </span>
        )}
      </span>
      <span className="bg-apollo-surface-2 h-3 rounded-sm" aria-hidden>
        <span
          className={cn("bg-apollo-maroon block h-3 rounded-sm", b.muted && "opacity-55")}
          style={{ width: `${Math.max(0, Math.min(1, b.fraction)) * 100}%` }}
        />
      </span>
      <span className="tabular-nums">{b.value}</span>
    </div>
  );
  return (
    <div className="mt-4" data-testid={testId}>
      <div className="text-muted-foreground grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] gap-3 pb-1 text-xs font-semibold tracking-[0.08em] uppercase">
        <span>{head}</span>
        <span />
        <span>{valueHead}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {bars.map((b) => (
          <li key={b.key} className="border-apollo-border border-t">
            {b.items ? (
              <details className="group">
                <summary className="hover:bg-apollo-surface-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                  {row(b, true)}
                </summary>
                <div className="pb-3 pl-5">{b.items}</div>
              </details>
            ) : (
              row(b, false)
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RadioGroup<T extends string>({
  name,
  value,
  options,
  counts,
}: {
  name: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  counts?: Partial<Record<T, number>>;
}) {
  return (
    <div className="flex flex-col gap-2">
      {options.map((o) => (
        <label key={o.value} className={RADIO}>
          <input
            type="radio"
            name={name}
            value={o.value}
            defaultChecked={o.value === value}
            className={RADIO_INPUT}
          />
          <span className="flex-1">{o.label}</span>
          {counts?.[o.value] !== undefined && (
            <span className="text-muted-foreground text-[13px] tabular-nums">
              {counts[o.value]!.toLocaleString()}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}

/** The download button and its note, or — when refused — only the note. */
export function DownloadAside({
  href,
  note,
  refused = false,
  testId,
}: {
  href: string | null;
  note: string;
  refused?: boolean;
  testId: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      {href && (
        <Button asChild variant="apollo">
          <a href={href} data-testid={`${testId}-download`}>
            <Download className="size-4" aria-hidden />
            Download .xlsx
          </a>
        </Button>
      )}
      <p
        className={cn("text-[13px]", refused ? "text-apollo-amber" : "text-muted-foreground")}
        data-testid={`${testId}-download-note`}
      >
        {note}
      </p>
    </div>
  );
}

/** The year-window `<select>`s ("Any" = unbounded when `allowAny`). */
export function YearWindow({
  from,
  to,
  years,
  allowAny = false,
}: {
  from: number | null;
  to: number | null;
  years: readonly number[];
  allowAny?: boolean;
}) {
  const select = (name: "from" | "to", value: number | null) => (
    <select
      name={name}
      defaultValue={value ?? ""}
      aria-label={name === "from" ? "From year" : "To year"}
      className={SELECT}
    >
      {allowAny && <option value="">Any</option>}
      {years.map((y) => (
        <option key={y} value={y}>
          {y}
        </option>
      ))}
    </select>
  );
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
      {select("from", from)}
      <span className="text-muted-foreground text-[13px]">to</span>
      {select("to", to)}
    </div>
  );
}

/** The no-JS Apply button (hidden once `AutoSubmitForm` hydrates). */
export function ApplyFallback() {
  return (
    <div className="px-[18px] pb-4 group-data-[hydrated=true]:hidden">
      <button
        type="submit"
        className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-3 py-1.5 text-sm"
      >
        Apply
      </button>
    </div>
  );
}
