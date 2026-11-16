"use client";

/**
 * The Usage dashboard's traffic sections (client island): KPI tiles (hits,
 * pageviews, average daily visitors), "Where visits come from" (stacked bars by
 * week or month with multi-select source chips), "Referring sites and pages"
 * (paged, searchable, filtered by the selected sources), "Top pages" (page-type
 * tabs and an "Arrived from" filter that switches to landing pages), and "AI"
 * (referrals, fetches, crawlers, companies).
 *
 * The overview (KPIs, per-day sources, AI) comes from the server page; the
 * three lists page through `GET /api/edit/usage/traffic` 25 rows at a time,
 * so search and filters cover every row, not just the ones on screen. The
 * Excel link hits `/api/edit/usage/traffic/export` for the same range.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DownloadIcon, ExternalLinkIcon } from "lucide-react";

import {
  REFERRER_CATEGORY_DISPLAY_ORDER,
  type ReferrerCategory,
} from "@/lib/analytics/referrer-category";
import {
  type Grain,
  type TrafficListPage,
  type TrafficListRow,
  type TrafficOverview,
  bucketAi,
  bucketSources,
  compactCount,
  sharePct,
  trafficPeriods,
  trafficStart,
} from "@/lib/analytics/traffic-view";
import { cn } from "@/lib/utils";

import { shortDay } from "./usage-format";

const cardClass = "border-apollo-border-strong bg-apollo-surface rounded-[13px] border";

/** One swatch color per source (the approved mockup's palette, plus NYP). */
export const CATEGORY_COLORS: Record<ReferrerCategory, string> = {
  "Search engines": "#34506e",
  "Old VIVO": "#9fb3c8",
  WCM: "#b5652e",
  "WCM clinical": "#e3b48c",
  "WCM-Q": "#6a4c9c",
  "Cornell (Ithaca)": "#c4b2e0",
  NYP: "#5e8c6a",
  "AI assistants": "#0e7480",
  Social: "#9a7d1f",
  Other: "#a8a29c",
  Fake: "#d9d2cb",
};

/** The "Arrived from" AI chips: label, AI class, color. */
const AI_SOURCES = [
  { name: "AI fetching for a person", cls: "fetch", color: "#34408a" },
  { name: "AI crawlers", cls: "crawler", color: "#6b6b6b" },
] as const;

const PAGE_KIND_TABS = [
  ["all", "All"],
  ["home", "Home and search"],
  ["profile", "Profiles"],
  ["topics", "Topics"],
  ["methods", "Methods"],
] as const;

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 flex-none rounded-[2px]"
      style={{ background: color }}
    />
  );
}

/** A two-or-more option toggle (By week / By month, Visits / Share…). */
function Segmented<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<readonly [K, string]>;
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="bg-apollo-page border-apollo-border-strong flex flex-wrap gap-0.5 rounded-lg border p-[3px]"
    >
      {options.map(([k, text]) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={value === k}
          onClick={() => onChange(k)}
          className={cn(
            "min-h-9 rounded-md px-3.5 py-1.5 text-sm",
            value === k
              ? "bg-apollo-surface font-semibold shadow-sm"
              : "text-muted-foreground hover:text-foreground font-medium",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Chip({
  on,
  color,
  onClick,
  children,
}: {
  on: boolean;
  color?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "bg-apollo-surface inline-flex min-h-9 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[13px]",
        on ? "border-foreground font-semibold" : "border-apollo-border-strong",
      )}
    >
      {color ? <Swatch color={color} /> : null}
      {children}
    </button>
  );
}

function toggle<T>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/** The list route's query string for the selected range. */
export type RangeQuery = string;

/**
 * One paged list from the traffic route: the first page on every change of
 * `query`, and `more()` for the next 25. A stale response (the filters changed
 * while it was in flight) is dropped.
 */
function useTrafficList(query: string) {
  const [rows, setRows] = useState<TrafficListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const seq = useRef(0);
  const fetchPage = useCallback(
    async (offset: number) => {
      const id = ++seq.current;
      setStatus("loading");
      try {
        const res = await fetch(`/api/edit/usage/traffic?${query}&offset=${offset}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`status_${res.status}`);
        const page = (await res.json()) as TrafficListPage;
        if (id !== seq.current) return;
        setRows((prev) => (offset === 0 ? page.rows : [...prev, ...page.rows]));
        if (offset === 0 || page.rows.length > 0) setTotal(page.total);
        setStatus("ok");
      } catch {
        if (id === seq.current) setStatus("error");
      }
    },
    [query],
  );
  useEffect(() => {
    void fetchPage(0);
  }, [fetchPage]);
  return { rows, total, status, more: () => void fetchPage(rows.length) };
}

function ListFooter({
  shown,
  total,
  noun,
  filtered,
  status,
  onMore,
  exportHref,
}: {
  shown: number;
  total: number;
  noun: string;
  filtered: boolean;
  status: "loading" | "ok" | "error";
  onMore: () => void;
  exportHref: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5 text-[13px]">
      <span data-testid="traffic-list-count">
        {status === "error"
          ? "Couldn't load this list. Try again later."
          : `Showing ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}${filtered ? " matching" : ""} ${noun}, busiest first`}
      </span>
      <div className="flex flex-wrap gap-2">
        {shown < total ? (
          <button
            type="button"
            onClick={onMore}
            disabled={status === "loading"}
            className="border-apollo-border-strong bg-apollo-surface min-h-11 rounded-lg border px-3.5 py-2 text-sm font-medium disabled:opacity-60"
          >
            Show 25 more
          </button>
        ) : null}
        <a
          href={exportHref}
          className="border-apollo-border-strong bg-apollo-surface inline-flex min-h-11 items-center rounded-lg border px-3.5 py-2 text-sm font-medium"
        >
          Download all (Excel)
        </a>
      </div>
    </div>
  );
}

function KpiTiles({ overview }: { overview: TrafficOverview }) {
  const { kpi } = overview;
  const tile = "flex flex-col gap-1.5 px-[18px] py-4";
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-3.5">
      <div className={cn(cardClass, tile)}>
        <span className="text-[13px] font-medium">Hits</span>
        <span className="text-3xl font-semibold tabular-nums" data-testid="traffic-hits">
          {compactCount(kpi.hits)}
        </span>
        <span className="text-muted-foreground text-[13px]">
          Every request: pages, images, scripts, bots, blocked ones.
        </span>
      </div>
      <div className={cn(cardClass, tile)}>
        <span className="text-[13px] font-medium">Pageviews</span>
        <span className="text-3xl font-semibold tabular-nums" data-testid="traffic-pageviews">
          {compactCount(kpi.pageviews)}
        </span>
        <span className="text-muted-foreground text-[13px]">
          A page served to a browser that doesn&apos;t call itself a bot.
        </span>
      </div>
      <div className={cn(cardClass, tile)}>
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-medium">Visitors a day</span>
          <span className="border-apollo-amber-tint-border bg-apollo-amber-tint text-foreground rounded-full border px-2 text-xs font-medium">
            Estimate
          </span>
        </span>
        <span className="text-3xl font-semibold tabular-nums" data-testid="traffic-visitors">
          {compactCount(kpi.visitorsAvg)}
        </span>
        <span className="text-muted-foreground text-[13px]">
          Average of each day&apos;s count of distinct network address plus browser. Campus NAT
          undercounts people; a proxy botnet counts every address as a new visitor.
        </span>
      </div>
    </div>
  );
}

function SourcesCard({
  overview,
  grain,
  mode,
  sel,
  setSel,
}: {
  overview: TrafficOverview;
  grain: Grain;
  mode: "count" | "share";
  sel: ReferrerCategory[];
  setSel: (s: ReferrerCategory[]) => void;
}) {
  const periods = useMemo(
    () => trafficPeriods(trafficStart(overview), overview.until, grain),
    [overview, grain],
  );
  const matrix = useMemo(() => bucketSources(overview.sourcesDaily, periods), [overview, periods]);
  const cats = REFERRER_CATEGORY_DISPLAY_ORDER;
  const none = sel.length === 0;
  const has = (c: ReferrerCategory) => none || sel.includes(c);
  const sums = periods.map((_, i) => cats.reduce((a, c) => a + matrix[c][i], 0));
  const maxSum = Math.max(...sums, 1);
  const totals = Object.fromEntries(
    cats.map((c) => [c, matrix[c].reduce((a, b) => a + b, 0)]),
  ) as Record<ReferrerCategory, number>;
  const all = cats.reduce((a, c) => a + totals[c], 0);
  const n = periods.length;
  const slot = 1000 / Math.max(n, 1);
  const bw = slot * 0.62;
  const last = n - 1;
  const prev = n - 2;
  const selNames = sel.join(", ");
  const { other, total } = overview.referrers;

  return (
    <section
      className={cn(cardClass, "flex flex-col gap-3.5 p-4 sm:p-5")}
      aria-labelledby="traffic-sources-h"
      data-testid="traffic-sources"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="traffic-sources-h" className="text-[17px] font-semibold">
          Where visits come from
        </h3>
        <span className="text-muted-foreground text-[13px]" data-testid="traffic-sources-caption">
          {mode === "share"
            ? `Share of each ${grain}'s referred visits`
            : `Referred visits per ${grain}`}
          {none ? "" : ` · number above each bar is ${selNames} combined`} · hover a segment for
          detail
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Sources">
        <Chip on={none} onClick={() => setSel([])}>
          All sources
        </Chip>
        {cats.map((c) => (
          <Chip
            key={c}
            on={!none && sel.includes(c)}
            color={CATEGORY_COLORS[c]}
            onClick={() => setSel(toggle(sel, c))}
          >
            {c}
          </Chip>
        ))}
      </div>
      {n === 0 || all === 0 ? (
        <p className="text-muted-foreground text-sm">No external referrals in this range.</p>
      ) : (
        <>
          <svg
            viewBox="0 0 1000 260"
            role="img"
            aria-label={`Referred visits by source per ${grain}`}
            className="block h-auto w-full"
          >
            <line x1="0" y1="250" x2="1000" y2="250" stroke="var(--apollo-border-strong)" />
            {periods.map((p, i) => {
              let y = 250;
              const shown = none ? sums[i] : sel.reduce((a, c) => a + matrix[c][i], 0);
              const segs = cats.flatMap((c) => {
                const v = matrix[c][i];
                if (!v) return [];
                const h = (mode === "share" ? v / sums[i] : v / maxSum) * 240;
                y -= h;
                return [
                  <rect
                    key={c}
                    x={i * slot + (slot - bw) / 2}
                    y={y}
                    width={bw}
                    height={Math.max(h, 0.5)}
                    fill={CATEGORY_COLORS[c]}
                    opacity={has(c) ? 1 : 0.18}
                  >
                    <title>{`${p.label}: ${c} ${v.toLocaleString("en-US")} (${sharePct(v, sums[i])})`}</title>
                  </rect>,
                ];
              });
              const label =
                mode === "share" && !none
                  ? sums[i]
                    ? sharePct(shown, sums[i])
                    : ""
                  : compactCount(shown);
              return (
                <g key={p.key}>
                  {segs}
                  <text
                    x={i * slot + slot / 2}
                    y={Math.max(y - 6, 12)}
                    textAnchor="middle"
                    fontSize="13"
                    fontWeight="600"
                    fill="currentColor"
                    data-testid="traffic-bar-total"
                  >
                    {label}
                  </text>
                </g>
              );
            })}
          </svg>
          <div className="flex">
            {periods.map((p) => (
              <div key={p.key} className="text-muted-foreground min-w-0 flex-1 text-center text-xs">
                {p.label}
              </div>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="bg-apollo-page text-left">
                  <th scope="col" className="px-2.5 py-2 font-medium">
                    Source
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">
                    {periods[last].label}
                  </th>
                  {prev >= 0 ? (
                    <th scope="col" className="px-2.5 py-2 text-right font-medium">
                      {periods[prev].label}
                    </th>
                  ) : null}
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">
                    Whole range
                  </th>
                  <th scope="col" className="px-2.5 py-2 text-right font-medium">
                    Share
                  </th>
                </tr>
              </thead>
              <tbody>
                {cats.map((c) => (
                  <tr
                    key={c}
                    className={cn(
                      "border-apollo-border border-t",
                      !none && sel.includes(c) && "bg-apollo-slate-tint",
                    )}
                  >
                    <th scope="row" className="px-1.5 py-1 text-left font-normal">
                      <button
                        type="button"
                        onClick={() => setSel(toggle(sel, c))}
                        className="inline-flex min-h-9 items-center gap-2 px-1 py-1.5 text-left"
                      >
                        <Swatch color={CATEGORY_COLORS[c]} />
                        {c}
                      </button>
                    </th>
                    <td className="px-2.5 py-2 text-right tabular-nums">
                      {compactCount(matrix[c][last])}
                    </td>
                    {prev >= 0 ? (
                      <td className="text-muted-foreground px-2.5 py-2 text-right tabular-nums">
                        {compactCount(matrix[c][prev])}
                      </td>
                    ) : null}
                    <td className="px-2.5 py-2 text-right tabular-nums">
                      {compactCount(totals[c])}
                    </td>
                    <td className="px-2.5 py-2 text-right tabular-nums">
                      {sharePct(totals[c], all)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="text-muted-foreground text-[13px] leading-normal">
        Click sources to select one or several: they are highlighted here, summed above each bar,
        and filter the referring sites below. All sources clears the selection. Fake = referrers
        that aren&apos;t real sites (www.google.edu, www.bing.edu…): bots forging where they came
        from.
        {other > 0
          ? ` ${other.toLocaleString("en-US")} referred visits (${sharePct(other, total)}) came from referrers past each day's top 5,000 and aren't sorted into a source.`
          : ""}
      </p>
    </section>
  );
}

function ReferrerList({
  rangeQuery,
  sel,
  siteOnlyShare,
  exportHref,
}: {
  rangeQuery: string;
  sel: ReferrerCategory[];
  siteOnlyShare: string | null;
  exportHref: string;
}) {
  const [view, setView] = useState<"site" | "page">("site");
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);
  const query = useMemo(() => {
    const p = new URLSearchParams(rangeQuery);
    p.set("list", "referrers");
    p.set("view", view);
    if (sel.length) p.set("cats", [...sel].sort().join(","));
    if (dq) p.set("q", dq);
    return p.toString();
  }, [rangeQuery, view, sel, dq]);
  const { rows, total, status, more } = useTrafficList(query);
  const noun = view === "site" ? "referring sites" : "referring pages";

  return (
    <section
      className={cn(cardClass, "flex flex-col gap-3 p-4 sm:p-5")}
      aria-labelledby="traffic-ref-h"
      data-testid="traffic-referrers"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 id="traffic-ref-h" className="text-[17px] font-semibold">
            Referring sites and pages
          </h3>
          <span className="text-muted-foreground text-[13px]">
            {sel.length ? `Showing ${sel.join(", ")}` : "All sources"}
          </span>
        </div>
        <Segmented
          label="List referrers by"
          options={[
            ["site", "By site"],
            ["page", "By page"],
          ]}
          value={view}
          onChange={setView}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="traffic-ref-q" className="text-[13px] font-medium">
            Search all {noun}
          </label>
          <input
            id="traffic-ref-q"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={100}
            placeholder="e.g. radiology, news"
            className="border-apollo-border-strong bg-apollo-surface min-h-11 w-[260px] max-w-full rounded-lg border px-3 py-2 text-sm"
          />
        </div>
      </div>
      {siteOnlyShare ? (
        <div className="border-apollo-slate-tint-border bg-apollo-slate-tint rounded-[10px] border px-3.5 py-2.5 text-[13px]">
          {siteOnlyShare} of referrals name only the site, not the page: browsers send just the site
          address when a link crosses to another site, unless that site allows more. Exact pages
          show up only where the linking site permits it.
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead>
            <tr className="bg-apollo-page text-left">
              <th scope="col" className="px-2.5 py-2 font-medium">
                Referrer
              </th>
              <th scope="col" className="px-2.5 py-2 font-medium">
                Source
              </th>
              <th scope="col" className="px-2.5 py-2 text-right font-medium">
                Visits
              </th>
              <th scope="col" className="px-2.5 py-2">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const slash = r.label.indexOf("/");
              const host = slash < 0 ? r.label : r.label.slice(0, slash);
              const path = slash < 0 || r.label.slice(slash) === "/" ? "" : r.label.slice(slash);
              const cat = r.category ?? "Other";
              return (
                <tr key={r.label} className="border-apollo-border border-t">
                  <td className="px-2.5 py-1.5 [overflow-wrap:anywhere]">
                    <span>{host}</span>
                    <span className="text-muted-foreground">{path}</span>
                    {view === "page" && !path ? (
                      <span className="bg-apollo-page text-muted-foreground ml-2 rounded-full px-2 py-px text-xs">
                        site only
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2.5 py-1.5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <Swatch color={CATEGORY_COLORS[cat]} />
                      {cat}
                    </span>
                  </td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">
                    {r.visits.toLocaleString("en-US")}
                  </td>
                  <td className="px-1.5 py-0.5 text-right">
                    {cat === "Fake" ? (
                      <span className="text-muted-foreground text-xs">not a real site</span>
                    ) : (
                      <a
                        href={`https://${r.label}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${r.label} in a new tab`}
                        className="text-apollo-slate inline-flex min-h-10 items-center gap-1 px-2 text-[13px] font-medium"
                      >
                        Open
                        <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {status === "ok" && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No referrers match.</p>
      ) : null}
      {status === "loading" && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : null}
      <ListFooter
        shown={rows.length}
        total={total}
        noun={noun}
        filtered={sel.length > 0 || dq !== ""}
        status={status}
        onMore={more}
        exportHref={exportHref}
      />
    </section>
  );
}

function TopPages({ rangeQuery, exportHref }: { rangeQuery: string; exportHref: string }) {
  const [kind, setKind] = useState<(typeof PAGE_KIND_TABS)[number][0]>("all");
  const [arr, setArr] = useState<string[]>([]);
  const query = useMemo(() => {
    const cats = arr.filter((a) =>
      (REFERRER_CATEGORY_DISPLAY_ORDER as readonly string[]).includes(a),
    );
    const ai = AI_SOURCES.filter((s) => arr.includes(s.name)).map((s) => s.cls);
    const p = new URLSearchParams(rangeQuery);
    p.set("list", "pages");
    p.set("kind", kind);
    if (cats.length) p.set("cats", [...cats].sort().join(","));
    if (ai.length) p.set("ai", [...ai].sort().join(","));
    return p.toString();
  }, [rangeQuery, kind, arr]);
  const { rows, total, status, more } = useTrafficList(query);
  const top = rows[0]?.visits || 1;
  const landing = arr.length > 0;

  return (
    <section
      className={cn(cardClass, "flex flex-col gap-3 p-4 sm:p-5")}
      aria-labelledby="traffic-pages-h"
      data-testid="traffic-pages"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 id="traffic-pages-h" className="text-[17px] font-semibold">
            Top pages
          </h3>
          <span className="text-muted-foreground text-[13px]">
            {landing
              ? "The first page opened, arriving from the selected sources"
              : "Every page, not just profiles"}
          </span>
        </div>
        <Segmented label="Page type" options={PAGE_KIND_TABS} value={kind} onChange={setKind} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span id="traffic-arr-l" className="text-[13px] font-medium">
          Arrived from
        </span>
        <div role="group" aria-labelledby="traffic-arr-l" className="flex flex-wrap gap-1.5">
          <Chip on={!landing} onClick={() => setArr([])}>
            All visits
          </Chip>
          {REFERRER_CATEGORY_DISPLAY_ORDER.map((c) => (
            <Chip
              key={c}
              on={arr.includes(c)}
              color={CATEGORY_COLORS[c]}
              onClick={() => setArr(toggle(arr, c))}
            >
              {c}
            </Chip>
          ))}
          {AI_SOURCES.map((s) => (
            <Chip
              key={s.name}
              on={arr.includes(s.name)}
              color={s.color}
              onClick={() => setArr(toggle(arr, s.name))}
            >
              {s.name}
            </Chip>
          ))}
        </div>
        <span className="text-muted-foreground text-[13px]">
          {landing
            ? `Showing landing pages for ${arr.join(", ")}. After the first page, clicks inside Scholars come from Scholars itself, so only the landing page belongs to a source.`
            : "Pick one or more sources to see where those visitors landed."}
        </span>
      </div>
      <div className="flex flex-col">
        {rows.map((r) => (
          <div
            key={r.label}
            className="border-apollo-border grid grid-cols-[minmax(0,1fr)_minmax(80px,30%)_80px] items-center gap-3 border-t py-[7px] text-sm"
          >
            <a
              href={r.label}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-apollo-slate [overflow-wrap:anywhere]"
            >
              {r.label}
            </a>
            <span className="bg-apollo-page block h-2.5 rounded" aria-hidden="true">
              <span
                className="bg-apollo-slate block h-2.5 rounded"
                style={{ width: `${Math.max(0.5, (100 * r.visits) / top)}%` }}
              />
            </span>
            <span className="text-right tabular-nums">{r.visits.toLocaleString("en-US")}</span>
          </div>
        ))}
      </div>
      {status === "ok" && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No pages match.</p>
      ) : null}
      {status === "loading" && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : null}
      <ListFooter
        shown={rows.length}
        total={total}
        noun={landing ? "landing pages" : "pages"}
        filtered={kind !== "all"}
        status={status}
        onMore={more}
        exportHref={exportHref}
      />
    </section>
  );
}

function MiniBars({
  title,
  sub,
  series,
  labels,
  color,
  testId,
}: {
  title: string;
  sub: string;
  series: number[];
  labels: string[];
  color: string;
  testId: string;
}) {
  const mx = Math.max(...series, 1);
  const s = 300 / Math.max(series.length, 1);
  const w = s * 0.6;
  return (
    <div
      className="border-apollo-border flex flex-col gap-2 rounded-[10px] border p-3.5"
      data-testid={testId}
    >
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-muted-foreground min-h-9 text-[13px]">{sub}</div>
      <div className="text-2xl font-semibold tabular-nums">
        {compactCount(series.reduce((a, b) => a + b, 0))}
      </div>
      <svg viewBox="0 0 300 90" role="img" aria-label={title} className="block h-auto w-full">
        <line x1="0" y1="88" x2="300" y2="88" stroke="var(--apollo-border-strong)" />
        {series.map((v, i) => {
          const h = Math.max((v / mx) * 84, v ? 1.5 : 0);
          return (
            <rect key={i} x={i * s + (s - w) / 2} y={88 - h} width={w} height={h} fill={color}>
              <title>{`${labels[i]}: ${v.toLocaleString("en-US")}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="text-muted-foreground flex justify-between text-xs">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}

function AiCard({ overview, grain }: { overview: TrafficOverview; grain: Grain }) {
  const periods = useMemo(
    () => trafficPeriods(trafficStart(overview), overview.until, grain),
    [overview, grain],
  );
  const ai = useMemo(() => bucketAi(overview.aiDaily, periods), [overview, periods]);
  const labels = periods.map((p) => p.label);
  const topVendor = overview.vendors[0]?.count || 1;
  return (
    <section
      className={cn(cardClass, "flex flex-col gap-4 p-4 sm:p-5")}
      aria-labelledby="traffic-ai-h"
      data-testid="traffic-ai"
    >
      <div className="flex flex-col gap-1">
        <h3 id="traffic-ai-h" className="text-[17px] font-semibold">
          AI
        </h3>
        <p className="text-muted-foreground text-sm">
          Three different things, each on its own scale. Hover a bar for its number.
        </p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-4">
        <MiniBars
          testId="traffic-ai-referrals"
          title="People sent by AI assistants"
          sub="Someone clicked a Scholars link in ChatGPT, Claude, Gemini, Perplexity…"
          series={ai.referral}
          labels={labels}
          color={CATEGORY_COLORS["AI assistants"]}
        />
        <MiniBars
          testId="traffic-ai-fetch"
          title="AI fetching for a person"
          sub="An assistant opened a page live because someone asked it (ChatGPT-User, Claude-User)."
          series={ai.fetch}
          labels={labels}
          color="#34408a"
        />
        <MiniBars
          testId="traffic-ai-crawler"
          title="AI crawlers"
          sub="Self-identified crawlers gathering pages for search or training (GPTBot, ClaudeBot…)."
          series={ai.crawler}
          labels={labels}
          color="#6b6b6b"
        />
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">Declared AI agents by company</h4>
        {overview.vendors.length === 0 ? (
          <p className="text-muted-foreground text-sm">No declared AI agents in this range.</p>
        ) : (
          overview.vendors.map((v) => (
            <div
              key={v.vendor}
              className="grid grid-cols-[120px_minmax(0,1fr)_90px] items-center gap-2.5 text-[13px]"
            >
              <span>{v.vendor}</span>
              <span className="bg-apollo-page block h-3 rounded" aria-hidden="true">
                <span
                  className="block h-3 rounded bg-[#6b6b6b]"
                  style={{ width: `${Math.max(0.5, (100 * v.count) / topVendor)}%` }}
                />
              </span>
              <span className="text-right tabular-nums">{v.count.toLocaleString("en-US")}</span>
            </div>
          ))
        )}
      </div>
      <div className="border-apollo-amber-tint-border bg-apollo-amber-tint rounded-[10px] border px-3.5 py-3 text-[13px]">
        <strong className="font-semibold">What this can&apos;t see:</strong> scrapers behind
        residential proxies never say who they are. They may be gathering AI training data, but
        nothing in the logs ties them to an AI company, so they aren&apos;t counted here.
      </div>
    </section>
  );
}

/**
 * The traffic sections. `rangeQuery` is the page's range as a query string
 * (`range=30`, or `range=custom&from=…&to=…`), passed through to the list and
 * export routes so they read the same window.
 */
export function TrafficSection({
  overview,
  rangeQuery,
}: {
  overview: TrafficOverview;
  rangeQuery: string;
}) {
  const [grain, setGrain] = useState<Grain>("week");
  const [mode, setMode] = useState<"count" | "share">("count");
  const [sel, setSel] = useState<ReferrerCategory[]>([]);
  const exportHref = `/api/edit/usage/traffic/export?${rangeQuery}${rangeQuery ? "&" : ""}grain=${grain}`;
  const { firstDt, since, until, referrers } = overview;
  const named = referrers.total - referrers.other;
  const siteOnlyShare = named > 0 ? sharePct(referrers.siteOnly, named) : null;

  return (
    <section className="flex flex-col gap-4" data-testid="usage-traffic">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-[17px] font-semibold">Traffic and referrers</h2>
          <p className="text-muted-foreground text-[13px]">
            Counts still include automated traffic the edge firewall let through.
            {firstDt && firstDt > since && firstDt <= until ? (
              <span data-testid="traffic-start-note">
                {" "}
                Traffic detail starts {shortDay(firstDt)}.
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="Group by"
            options={[
              ["week", "By week"],
              ["month", "By month"],
            ]}
            value={grain}
            onChange={setGrain}
          />
          <Segmented
            label="Show as"
            options={[
              ["count", "Visits"],
              ["share", "Share"],
            ]}
            value={mode}
            onChange={setMode}
          />
          <a
            href={exportHref}
            data-testid="traffic-download-excel"
            className="bg-apollo-maroon text-apollo-maroon-foreground hover:bg-apollo-maroon-press inline-flex min-h-11 items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium"
          >
            <DownloadIcon className="size-4" aria-hidden="true" />
            Download Excel
          </a>
        </div>
      </div>
      {firstDt === null || firstDt > until ? (
        <p
          className={cn(cardClass, "text-muted-foreground px-5 py-4 text-sm")}
          data-testid="traffic-empty"
        >
          {firstDt === null
            ? "No traffic detail yet. It is recorded from the first nightly rollup of the traffic table."
            : `Traffic detail starts ${shortDay(firstDt)}, after this range ends.`}
        </p>
      ) : (
        <>
          <KpiTiles overview={overview} />
          <SourcesCard overview={overview} grain={grain} mode={mode} sel={sel} setSel={setSel} />
          <ReferrerList
            rangeQuery={rangeQuery}
            sel={sel}
            siteOnlyShare={siteOnlyShare}
            exportHref={exportHref}
          />
          <TopPages rangeQuery={rangeQuery} exportHref={exportHref} />
          <AiCard overview={overview} grain={grain} />
        </>
      )}
    </section>
  );
}
