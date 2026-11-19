"use client";

/**
 * Client islands for `/edit/usage` (2026-09 page revision): the hoverable
 * pageviews-by-day chart, the two ranked tables (Show all + client-side CSV),
 * and the "How uptime is measured" popover. Everything else on the page stays
 * server-rendered in `page.tsx`.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ChevronDownIcon, ChevronUpIcon, DownloadIcon, InfoIcon } from "lucide-react";

import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  USAGE_HISTORY_START,
  USAGE_RANGE_OPTIONS,
  type UsageRangeKey,
  isRealIsoDate,
  usageRangeHref,
} from "@/lib/api/usage-range";
import {
  type ClassCounts,
  type EditHour,
  type HourlyTraffic,
  TRAFFIC_CLASSES,
  type TrafficClass,
  editsHourOfDayAverages,
  hourLabel,
  hourOfDayAverages,
  hourlyTimeline,
} from "@/lib/api/usage-hourly";
import { toCsv } from "@/lib/csv";
import { cn } from "@/lib/utils";

import { type ChartDay, isWeekend, niceCeil, shortDay } from "./usage-format";

/** The header's "Range" dropdown: Last 7 / 30 / 90 days, Since launch, or a
 *  custom from/to. The choice lives in the URL (`?range=`, plus `from`/`to`
 *  for custom), so the server page reads the matching window and each range
 *  is linkable. The trigger dims while the new range loads. */
export function UsageRangePicker({
  current,
  since,
  until,
  maxDate,
}: {
  current: UsageRangeKey;
  /** The resolved window, to seed the custom inputs. */
  since: string;
  until: string;
  /** Latest selectable day (yesterday: today has no rollup yet). */
  maxDate: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(current === "custom");
  const [from, setFrom] = useState(since);
  const [to, setTo] = useState(until);
  // A same-route `router.push` re-renders this island with new props rather
  // than remounting it, so the seeded state above would go stale. Re-seed it
  // whenever the resolved range changes (React's adjust-state-during-render
  // pattern: no effect, no flash of the old values).
  const rangeKey = `${current}|${since}|${until}`;
  const [seededFor, setSeededFor] = useState(rangeKey);
  if (seededFor !== rangeKey) {
    setSeededFor(rangeKey);
    setCustomOpen(current === "custom");
    setFrom(since);
    setTo(until);
  }
  const label =
    current === "custom"
      ? `${shortDay(since)} – ${shortDay(until)}`
      : (USAGE_RANGE_OPTIONS.find((o) => o.key === current)?.label ?? "Last 30 days");
  const customValid = isRealIsoDate(from) && isRealIsoDate(to);

  const go = (href: string) => {
    setOpen(false);
    startTransition(() => router.push(href, { scroll: false }));
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-[13px]" id="usage-range-label">
        Range
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          type="button"
          aria-labelledby="usage-range-label usage-range-value"
          aria-busy={pending || undefined}
          className={cn(
            "border-apollo-border-strong bg-apollo-surface text-foreground flex h-[34px] items-center gap-2.5 rounded-lg border pr-2.5 pl-3 text-[13.5px] whitespace-nowrap",
            pending && "opacity-60",
          )}
          data-testid="usage-range-trigger"
        >
          <span id="usage-range-value">{label}</span>
          {open ? (
            <ChevronUpIcon className="text-muted-foreground size-4" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="text-muted-foreground size-4" aria-hidden="true" />
          )}
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-[min(260px,90vw)] flex-col p-1">
          {USAGE_RANGE_OPTIONS.map((o) => {
            const selected = o.key === current;
            return (
              <button
                key={o.key}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  o.key === "custom" ? setCustomOpen(!customOpen) : go(usageRangeHref(o.key))
                }
                className={cn(
                  "hover:bg-apollo-surface-2 flex justify-between gap-4 rounded-md px-3 py-2 text-left text-[13.5px] whitespace-nowrap",
                  selected ? "text-apollo-slate font-medium" : "text-foreground",
                  o.key === "custom" && "border-apollo-border mt-1 rounded-t-none border-t",
                )}
              >
                <span>{o.label}</span>
                {o.hint ? (
                  <span className="text-muted-foreground text-[12.5px] font-normal">{o.hint}</span>
                ) : null}
              </button>
            );
          })}
          {customOpen ? (
            <form
              className="flex flex-col gap-2 px-3 pt-1 pb-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (customValid) go(usageRangeHref("custom", from, to));
              }}
              data-testid="usage-range-custom"
            >
              <label className="text-muted-foreground flex items-center justify-between gap-2 text-[12.5px]">
                From
                <input
                  type="date"
                  value={from}
                  min={USAGE_HISTORY_START}
                  max={maxDate}
                  onChange={(e) => setFrom(e.target.value)}
                  className="border-apollo-border-strong text-foreground h-8 rounded-md border px-2 text-[13px]"
                />
              </label>
              <label className="text-muted-foreground flex items-center justify-between gap-2 text-[12.5px]">
                To
                <input
                  type="date"
                  value={to}
                  min={USAGE_HISTORY_START}
                  max={maxDate}
                  onChange={(e) => setTo(e.target.value)}
                  className="border-apollo-border-strong text-foreground h-8 rounded-md border px-2 text-[13px]"
                />
              </label>
              <button
                type="submit"
                disabled={!customValid}
                className="bg-apollo-slate self-end rounded-md px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
              >
                Apply
              </button>
            </form>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Profile pageviews by day — flex bars, weekends lighter, hover (or tap) a bar
 *  for its exact count in the header line. A `null` day (no rollup row) keeps
 *  its slot on the axis but draws no bar: a gap, not a zero. */
export function PageviewsChart({ data }: { data: ChartDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = niceCeil(Math.max(...data.map((d) => d.views ?? 0), 1));
  const gaps = data.filter((d) => d.views === null).length;
  const ticks = [0, top / 2, top];
  const hd = hover === null ? null : data[hover];
  // Label every `stride`-th day (every 4th for a month, wider for longer
  // ranges so about eight labels fit), twice as sparse at phone width.
  const stride = data.length <= 7 ? 1 : Math.max(4, Math.ceil(data.length / 8));
  // Past ~45 bars the per-bar gap would eat the bars themselves.
  const gap = data.length > 45 ? "gap-px" : "gap-[2px] sm:gap-1";

  return (
    <section
      className="border-apollo-border-strong bg-apollo-surface flex flex-col gap-3.5 rounded-[13px] border px-4 pt-5 pb-4 sm:px-[22px]"
      data-testid="usage-pageviews-chart"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[17px] font-semibold">Profile pageviews by day</h2>
        <span className="text-muted-foreground text-[13px]" aria-live="polite">
          {hd
            ? hd.views === null
              ? `${shortDay(hd.day)}: no data`
              : `${shortDay(hd.day)}: ${hd.views.toLocaleString()} pageviews`
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
              className={cn("absolute inset-0 flex items-end", gap)}
              role="img"
              aria-label={`Profile pageviews per day, ${data.length} days${gaps ? `, ${gaps} with no data` : ""}`}
              onMouseLeave={() => setHover(null)}
            >
              {data.map((d, i) => (
                <div
                  key={d.day}
                  title={`${shortDay(d.day)}: ${d.views === null ? "no data" : d.views.toLocaleString()}`}
                  className="flex h-full flex-1 items-end"
                  onMouseEnter={() => setHover(i)}
                  onClick={() => setHover(i)}
                  data-gap={d.views === null || undefined}
                >
                  {d.views === null ? null : (
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
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className={cn("text-muted-foreground flex text-[11.5px]", gap)} aria-hidden="true">
            {data.map((d, i) => (
              <span
                key={d.day}
                className={cn(
                  "flex-1 overflow-visible text-center whitespace-nowrap",
                  // Every stride-th day on desktop; every 2x stride at phone width.
                  data.length > 7 && i % (stride * 2) !== 0 && "max-sm:invisible",
                )}
              >
                {i % stride === 0 ? shortDay(d.day) : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Series styling for the hourly chart: error stacks at the baseline in the
 *  warm brick red so an outage reads at a glance; served (the `human` class)
 *  is the slate the pageviews chart uses; bot or challenged a muted tan. The
 *  labels say what the edge can actually tell apart: a "human" request is one
 *  the firewall served, which includes automation that got past it. */
const SERIES: Record<TrafficClass, { label: string; fill: string; swatch: string }> = {
  error: { label: "Error", fill: "fill-apollo-brick", swatch: "bg-apollo-brick" },
  human: { label: "Served", fill: "fill-apollo-slate", swatch: "bg-apollo-slate" },
  bot: {
    label: "Bot or challenged",
    fill: "fill-[var(--apollo-signal-affinity)]",
    swatch: "bg-[var(--apollo-signal-affinity)]",
  },
};
/** Bottom-to-top stack order. */
const STACK: TrafficClass[] = ["error", "human", "bot"];
/** Days of hourly bars the timeline shows at most (720 bars). */
const HOURLY_TIMELINE_DAYS = 30;

function fmtCount(v: number, avg: boolean): string {
  if (!avg) return v.toLocaleString();
  return v >= 10 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toLocaleString();
}

/** "Served 120 · Bot or challenged 40 · Error 2" over the visible series. */
function countsLine(c: ClassCounts, shown: TrafficClass[], avg: boolean): string {
  return TRAFFIC_CLASSES.filter((k) => shown.includes(k))
    .map((k) => `${SERIES[k].label} ${fmtCount(c[k], avg)}`)
    .join(" · ");
}

const EDITS_LABEL = "Profile edits";

/** "Traffic by hour": page requests per Eastern hour, stacked served / bot or
 *  challenged / error, across the range (capped to the last 30 days), or
 *  folded into 24 hours of the day (average per day), with people's profile
 *  edits as a line on its own right-hand scale. The legend toggles series;
 *  hover (or tap) a bar for its counts. An hour with no rollup data is a gap.
 *  `edits` null means the audit-log read failed: no line, a short note. */
export function HourlyTrafficChart({
  traffic,
  since,
  edits,
  editsLabel = EDITS_LABEL,
}: {
  traffic: HourlyTraffic;
  since: string;
  /** Profile edits by hour; null when unavailable, omitted for no line. */
  edits?: EditHour[] | null;
  /** The edits line's name; a unit-scoped page says whose edits it counts. */
  editsLabel?: string;
}) {
  const [mode, setMode] = useState<"timeline" | "hourOfDay">("timeline");
  const [hidden, setHidden] = useState<TrafficClass[]>([]);
  const [editsHidden, setEditsHidden] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const shown = TRAFFIC_CLASSES.filter((k) => !hidden.includes(k));
  const avg = mode === "hourOfDay";
  const hasEdits = Array.isArray(edits);
  const showEdits = hasEdits && !editsHidden;

  const { slots, capped } = hourlyTimeline(traffic.buckets, HOURLY_TIMELINE_DAYS);
  const bars: { key: number; counts: ClassCounts | null; tip: string }[] = avg
    ? hourOfDayAverages(traffic).map((r) => ({
        key: r.hour,
        counts: r,
        tip: `${hourLabel(r.hour)} ET, average per day`,
      }))
    : slots.map((s) => ({
        key: s.at,
        counts: s.counts,
        tip: `${shortDay(s.day)}, ${hourLabel(s.hour)} ET`,
      }));
  const total = (c: ClassCounts | null) => (c ? shown.reduce((a, k) => a + c[k], 0) : 0);
  const top = niceCeil(Math.max(...bars.map((b) => total(b.counts)), 1));
  const ticks = [0, top / 2, top];
  const n = Math.max(bars.length, 1);
  const pad = n > 120 ? 0 : 0.12;
  const hb = hover === null ? null : (bars[hover] ?? null);

  // The edits line: one value per bar, on its own scale.
  const editValues: number[] = !hasEdits
    ? []
    : avg
      ? editsHourOfDayAverages(edits, traffic)
      : (() => {
          const byAt = new Map(edits.map((e) => [e.at, e.edits]));
          return slots.map((s) => byAt.get(s.at) ?? 0);
        })();
  const editTop = niceCeil(Math.max(...editValues, 1));
  const editTicks = [0, editTop / 2, editTop];
  const editPoints = editValues.map((v, i) => `${i + 0.5},${100 - (v / editTop) * 100}`).join(" ");
  const readout = (b: (typeof bars)[number], i: number): string => {
    const parts: string[] = [];
    if (b.counts === null) parts.push("no data");
    else {
      const line = countsLine(b.counts, shown, avg);
      if (line) parts.push(line);
    }
    if (showEdits) parts.push(`${editsLabel} ${fmtCount(editValues[i] ?? 0, avg)}`);
    return `${b.tip}: ${parts.join(" · ") || "all series hidden"}`;
  };

  // X labels: hour of day every 3 hours; the timeline at Eastern midnights,
  // about eight across.
  const labels: { i: number; text: string }[] = avg
    ? bars.filter((b) => b.key % 3 === 0).map((b) => ({ i: b.key, text: hourLabel(b.key) }))
    : (() => {
        const mids = slots.flatMap((s, i) => (s.hour === 0 ? [{ i, text: shortDay(s.day) }] : []));
        const stride = Math.max(1, Math.ceil(mids.length / 8));
        return mids.filter((_, j) => j % stride === 0);
      })();

  const pick = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    const i = Math.floor(((e.clientX - r.left) / r.width) * n);
    setHover(i >= 0 && i < bars.length ? i : null);
  };
  const toggle = (k: TrafficClass) =>
    setHidden(hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k]);

  return (
    <section
      className="border-apollo-border-strong bg-apollo-surface flex flex-col gap-3.5 rounded-[13px] border px-4 pt-5 pb-4 sm:px-[22px]"
      data-testid="usage-hourly-chart"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="text-[17px] font-semibold">Traffic by hour</h2>
        <div className="border-apollo-border-strong flex rounded-lg border p-0.5 text-[13px]">
          {(
            [
              ["timeline", "Timeline"],
              ["hourOfDay", "By hour of day"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={mode === key}
              onClick={() => {
                setMode(key);
                setHover(null);
              }}
              className={cn(
                "rounded-md px-2.5 py-1",
                mode === key
                  ? "bg-apollo-slate-tint text-apollo-slate font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {TRAFFIC_CLASSES.map((k) => {
          const on = !hidden.includes(k);
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(k)}
              className={cn(
                "inline-flex items-center gap-1.5 text-[13px]",
                on ? "text-foreground" : "text-muted-foreground line-through",
              )}
              data-testid={`usage-hourly-legend-${k}`}
            >
              <span
                className={cn(
                  "size-2.5 rounded-[2px]",
                  on ? SERIES[k].swatch : "border-apollo-border-strong border bg-transparent",
                )}
                aria-hidden="true"
              />
              {SERIES[k].label}
            </button>
          );
        })}
        {hasEdits ? (
          <button
            type="button"
            aria-pressed={!editsHidden}
            onClick={() => setEditsHidden(!editsHidden)}
            className={cn(
              "inline-flex items-center gap-1.5 text-[13px]",
              editsHidden ? "text-muted-foreground line-through" : "text-foreground",
            )}
            data-testid="usage-hourly-legend-edits"
          >
            <span
              className={cn(
                "h-0.5 w-3 rounded-full",
                editsHidden ? "bg-apollo-border-strong" : "bg-[var(--apollo-ink)]",
              )}
              aria-hidden="true"
            />
            {editsLabel} (right scale)
          </button>
        ) : edits === null ? (
          <span
            className="text-muted-foreground text-[13px]"
            data-testid="usage-hourly-edits-unavailable"
          >
            Profile edits unavailable right now.
          </span>
        ) : null}
        <span
          className="text-muted-foreground text-[13px]"
          aria-live="polite"
          data-testid="usage-hourly-readout"
        >
          {hb && hover !== null ? readout(hb, hover) : "Hover a bar for the counts"}
        </span>
      </div>
      <div
        className={cn(
          "grid gap-2",
          hasEdits ? "grid-cols-[40px_minmax(0,1fr)_32px]" : "grid-cols-[40px_minmax(0,1fr)]",
        )}
      >
        <div className="text-muted-foreground relative h-[220px] text-[11.5px] tabular-nums">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 translate-y-1/2"
              style={{ bottom: `${(t / top) * 100}%` }}
            >
              {fmtCount(t, avg)}
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
            <svg
              className="absolute inset-0 h-full w-full"
              viewBox={`0 0 ${n} 100`}
              preserveAspectRatio="none"
              role="img"
              aria-label={
                (avg
                  ? "Average page requests per day by hour of day (Eastern): served, bot or challenged, and error"
                  : `Page requests per hour (Eastern): served, bot or challenged, and error, ${bars.length} hours`) +
                (hasEdits ? "; profile edits as a line on the right-hand scale" : "")
              }
              onMouseMove={pick}
              onClick={pick}
              onMouseLeave={() => setHover(null)}
            >
              {hover !== null ? (
                <rect x={hover} y={0} width={1} height={100} className="fill-apollo-surface-2" />
              ) : null}
              {bars.map((b, i) => {
                const c = b.counts;
                if (!c) return null;
                let y = 100;
                return (
                  <g key={b.key}>
                    {STACK.filter((k) => shown.includes(k)).map((k) => {
                      const h = (c[k] / top) * 100;
                      y -= h;
                      return h > 0 ? (
                        <rect
                          key={k}
                          x={i + pad}
                          y={y}
                          width={1 - 2 * pad}
                          height={h}
                          className={SERIES[k].fill}
                          data-series={k}
                        />
                      ) : null;
                    })}
                  </g>
                );
              })}
              {showEdits && editValues.length > 0 ? (
                <polyline
                  points={editPoints}
                  fill="none"
                  className="stroke-[var(--apollo-ink)]"
                  strokeWidth={1.75}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  data-series="edits"
                />
              ) : null}
            </svg>
          </div>
          <div className="text-muted-foreground relative h-4 text-[11.5px]" aria-hidden="true">
            {labels.map((l, j) => (
              <span
                key={l.i}
                className={cn(
                  "absolute -translate-x-1/2 whitespace-nowrap",
                  // Every other label at phone width.
                  j % 2 === 1 && "max-sm:invisible",
                )}
                style={{ left: `${((l.i + (avg ? 0.5 : 0)) / n) * 100}%` }}
              >
                {l.text}
              </span>
            ))}
          </div>
        </div>
        {hasEdits ? (
          <div
            className="text-muted-foreground relative h-[220px] text-[11.5px] tabular-nums"
            data-testid="usage-hourly-edits-axis"
          >
            {editTicks.map((t) => (
              <span
                key={t}
                className="absolute left-0 translate-y-1/2"
                style={{ bottom: `${(t / editTop) * 100}%` }}
              >
                {fmtCount(t, avg)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <p className="text-muted-foreground text-[12.5px] leading-normal">
        Page requests (not assets or API calls), Eastern time.{" "}
        {avg
          ? `Average per day over ${traffic.days.toLocaleString()} day${traffic.days === 1 ? "" : "s"}. `
          : capped
            ? `Showing the most recent ${HOURLY_TIMELINE_DAYS} days of the range. `
            : ""}
        Bot or challenged is declared crawlers plus requests the edge firewall challenged, blocked
        or rate-limited. Served traffic still includes automated clients that passed the firewall,
        so a flat curve around the clock suggests automation. Error is a server error (5xx), which
        is what an outage looks like.
        {hasEdits
          ? " Profile edits are saves people made in the edit console (automated and bulk-job edits left out), on the right-hand scale."
          : ""}
        {traffic.firstDay && traffic.firstDay > since
          ? ` Hourly data starts ${shortDay(traffic.firstDay)}.`
          : ""}
      </p>
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
  note,
}: {
  testId: string;
  title: string;
  unit: string;
  labelHeader: string;
  extraHeader?: string;
  csvName: string;
  rows: RankRow[];
  emptyLabel: string;
  /** Muted one-liner under the title (what the list counts). */
  note?: string;
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
      {note ? (
        <p className="text-muted-foreground -mt-1 px-4 pb-2.5 text-[12.5px] leading-normal sm:px-5">
          {note}
        </p>
      ) : null}
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
      <Link
        href={row.href}
        prefetch={false}
        className={cn(cls, "hover:text-apollo-slate")}
        title={row.tip}
      >
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
        prefetch={false}
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
