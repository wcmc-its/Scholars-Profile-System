"use client";

/**
 * Client islands for `/edit/usage` (2026-09 page revision): the hoverable
 * pageviews-by-day chart, the two ranked tables (Show all + client-side CSV),
 * and the "How uptime is measured" popover. Everything else on the page stays
 * server-rendered in `page.tsx`.
 */
import Link from "next/link";
import { useState } from "react";
import { DownloadIcon, InfoIcon } from "lucide-react";

import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toCsv } from "@/lib/csv";
import { cn } from "@/lib/utils";

import { isWeekend, niceCeil, shortDay } from "./usage-format";

/** Profile pageviews by day — flex bars, weekends lighter, hover (or tap) a bar
 *  for its exact count in the header line. */
export function PageviewsChart({ data }: { data: { day: string; views: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = niceCeil(Math.max(...data.map((d) => d.views), 1));
  const ticks = [0, top / 2, top];
  const hd = hover === null ? null : data[hover];

  return (
    <section
      className="border-apollo-border-strong bg-apollo-surface flex flex-col gap-3.5 rounded-[13px] border px-4 pt-5 pb-4 sm:px-[22px]"
      data-testid="usage-pageviews-chart"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[17px] font-semibold">Profile pageviews by day</h2>
        <span className="text-muted-foreground text-[13px]" aria-live="polite">
          {hd
            ? `${shortDay(hd.day)}: ${hd.views.toLocaleString()} pageviews`
            : "Hover a bar for the exact count"}
        </span>
      </div>
      <div className="grid grid-cols-[40px_minmax(0,1fr)] gap-2">
        <div className="text-muted-foreground relative h-[220px] text-[11.5px] tabular-nums">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 translate-y-1/2"
              style={{ bottom: `${(t / top) * 100}%` }}
            >
              {t.toLocaleString()}
            </span>
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="relative h-[220px]">
            {ticks.map((t) => (
              <div
                key={t}
                className={cn(
                  "absolute inset-x-0 border-t",
                  t ? "border-apollo-border" : "border-apollo-border-strong",
                )}
                style={{ bottom: `${(t / top) * 100}%` }}
              />
            ))}
            <div
              className="absolute inset-0 flex items-end gap-[2px] sm:gap-1"
              role="img"
              aria-label={`Profile pageviews per day, ${data.length} days`}
              onMouseLeave={() => setHover(null)}
            >
              {data.map((d, i) => (
                <div
                  key={d.day}
                  title={`${shortDay(d.day)}: ${d.views.toLocaleString()}`}
                  className="flex h-full flex-1 items-end"
                  onMouseEnter={() => setHover(i)}
                  onClick={() => setHover(i)}
                >
                  <div
                    className={cn(
                      "w-full rounded-t-[3px]",
                      hover === i
                        ? "bg-apollo-bar"
                        : isWeekend(d.day)
                          ? "bg-apollo-slate/45"
                          : "bg-apollo-slate",
                    )}
                    style={{ height: `${(d.views / top) * 100}%`, minHeight: d.views ? 2 : 0 }}
                  />
                </div>
              ))}
            </div>
          </div>
          <div
            className="text-muted-foreground flex gap-[2px] text-[11.5px] sm:gap-1"
            aria-hidden="true"
          >
            {data.map((d, i) => (
              <span
                key={d.day}
                className={cn(
                  "flex-1 overflow-visible text-center whitespace-nowrap",
                  // Every 4th day on desktop; every 8th at phone width so labels don't collide.
                  data.length > 7 && i % 8 !== 0 && "max-sm:invisible",
                )}
              >
                {data.length <= 7 || i % 4 === 0 ? shortDay(d.day) : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export type RankRow = {
  label: string;
  count: number;
  /** Link target (profiles only). */
  href?: string;
  /** Scholar cwid for the shared hover card, when the slug resolved to one. */
  cwid?: string;
  /** Native tooltip (the raw slug for an unresolved profile). */
  tip?: string;
  /** Extra CSV cell (the slug for profiles). */
  csvExtra?: string;
};

const COLLAPSED_ROWS = 20;

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** A ranked list with an in-row proportional tint bar, a Download CSV link and
 *  a Show all / Show top 20 toggle. */
export function RankTable({
  testId,
  title,
  unit,
  labelHeader,
  extraHeader,
  csvName,
  rows,
  emptyLabel,
}: {
  testId: string;
  title: string;
  unit: string;
  labelHeader: string;
  extraHeader?: string;
  csvName: string;
  rows: RankRow[];
  emptyLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, COLLAPSED_ROWS);
  const top = rows[0]?.count || 1;

  const onDownload = () => {
    const headers = ["Rank", labelHeader, ...(extraHeader ? [extraHeader] : []), unit];
    const body = rows.map((r, i) => [
      i + 1,
      r.label,
      ...(extraHeader ? [r.csvExtra ?? ""] : []),
      r.count,
    ]);
    downloadCsv(`${csvName}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, body));
  };

  return (
    <section
      className="border-apollo-border-strong bg-apollo-surface overflow-hidden rounded-[13px] border"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-4 pb-2.5 sm:px-5">
        <h2 className="text-[17px] leading-snug font-semibold">{title}</h2>
        <div className="flex items-center gap-3.5 leading-none">
          {rows.length > 0 ? (
            <button
              type="button"
              onClick={onDownload}
              className="text-apollo-slate inline-flex items-center gap-1.5 text-[13px] hover:underline"
            >
              <DownloadIcon className="size-[13px]" aria-hidden="true" />
              Download CSV
            </button>
          ) : null}
          <span className="text-muted-foreground text-xs tracking-[.08em] uppercase">{unit}</span>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="border-apollo-border text-muted-foreground border-t px-4 py-3 text-sm sm:px-5">
          {emptyLabel}
        </p>
      ) : (
        <ol>
          {shown.map((r, i) => (
            <li
              key={`${r.label}-${i}`}
              className="border-apollo-border grid grid-cols-[24px_minmax(0,1fr)_44px] items-center gap-2.5 border-t px-4 py-[7px] sm:px-5"
            >
              <span className="text-muted-foreground text-[12.5px] tabular-nums">{i + 1}</span>
              <div className="relative min-w-0 overflow-hidden rounded-[5px] px-2 py-[3px]">
                <div
                  className="bg-apollo-slate-tint absolute inset-y-0 left-0 rounded-[5px]"
                  style={{ width: `${(r.count / top) * 100}%` }}
                  aria-hidden="true"
                />
                <div className="relative flex min-w-0 items-baseline">
                  <RankLabel row={r} />
                </div>
              </div>
              <span className="text-right text-sm font-medium tabular-nums">
                {r.count.toLocaleString()}
              </span>
            </li>
          ))}
        </ol>
      )}
      {rows.length > COLLAPSED_ROWS ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="border-apollo-border bg-apollo-page text-apollo-slate w-full border-t p-2.5 text-[13px] hover:underline"
        >
          {open ? `Show top ${COLLAPSED_ROWS}` : `Show all ${rows.length}`}
        </button>
      ) : null}
    </section>
  );
}

function RankLabel({ row }: { row: RankRow }) {
  const cls = "truncate text-sm";
  if (!row.href) {
    return (
      <span className={cls} title={row.tip ?? row.label}>
        {row.label || "—"}
      </span>
    );
  }
  if (!row.cwid) {
    return (
      <Link href={row.href} className={cn(cls, "hover:text-apollo-slate")} title={row.tip}>
        {row.label}
      </Link>
    );
  }
  // Radix's hover-card trigger cancels a link's click on iOS; re-issue it on
  // touch end (the RosterScholarCell / #2588 pattern).
  return (
    <ScholarHoverCard cwid={row.cwid}>
      <Link
        href={row.href}
        className={cn(cls, "hover:text-apollo-slate")}
        onTouchEnd={(e) => {
          e.preventDefault();
          e.currentTarget.click();
        }}
      >
        {row.label}
      </Link>
    </ScholarHoverCard>
  );
}

/** The ⓘ beside "Uptime since launch". */
export function UptimeInfoButton() {
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label="How uptime is measured"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex size-[18px] shrink-0 items-center justify-center self-center rounded-full focus:outline-none focus-visible:ring-2"
      >
        <InfoIcon className="size-4" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-[min(340px,90vw)] flex-col gap-2 text-[13.5px] leading-normal"
      >
        <span className="font-semibold">How uptime is measured</span>
        <span>
          Uptime is the share of requests the public load balancer served without a server error
          (5xx), from its daily CloudWatch metrics.
        </span>
        <span>
          Availability alarms count the times the site-down alarm fired: a server-error burst, no
          healthy hosts, too few running tasks, or a failed synthetic check of the site. They catch
          outages that happen when there’s no traffic to count.
        </span>
        <span className="text-muted-foreground">
          Months with fewer than 1,000 requests are shown lighter, because the percentage isn’t a
          reliable signal at that volume.
        </span>
      </PopoverContent>
    </Popover>
  );
}
