/**
 * The "Running normally" section of `/edit/etl-status` — the healthy imports,
 * grouped by how often they run, with a text filter and an External / Internal
 * switch.
 *
 * A client island ONLY for the filter, the origin switch and the hide/show
 * toggle. Everything a reader sees is computed on the server and handed over as
 * plain strings: dates are pre-formatted in Eastern time (so the client never
 * re-formats and cannot disagree with the server render), rows arrive already
 * in their sort order, and the column headers stay plain `?sort=` links the
 * server re-sorts on — the same sorting contract the page had before.
 *
 * Every row here is up to date by construction (see `inAttentionSection` in the
 * page), which is why there is no status column: it could only ever say one thing.
 */
"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type NormalGroupKey = "nightly" | "weekly" | "monthly" | "annual";
export type NormalSortKey = "import" | "source" | "freshness" | "lastGood" | "duration";
export type NormalSortDir = "asc" | "desc";

export type NormalRow = {
  source: string;
  label: string;
  description: string | null;
  origin: "external" | "internal" | null;
  group: NormalGroupKey;
  /** "Sep 25, 03:26" in Eastern time; "—" when there is no good data. */
  lastGood: string;
  /** "10 hours ago". */
  ago: string;
  /** Age as a share of the time allowed before the import counts as late, 0..1. */
  fraction: number | null;
  /** Hover text for the freshness bar. */
  freshTip: string;
  /** "24 sec", "still running", or "—" when no start time was logged. */
  took: string;
  /** Measured run time in ms; null when there is no measurement to add up. */
  tookMs: number | null;
};

const GROUPS: ReadonlyArray<{ key: NormalGroupKey; label: string }> = [
  { key: "nightly", label: "Nightly" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "annual", label: "Yearly" },
];

const COLUMNS: ReadonlyArray<{
  key: NormalSortKey;
  label: string;
  title?: string;
  right?: boolean;
}> = [
  { key: "import", label: "Data import" },
  { key: "source", label: "Source" },
  {
    key: "freshness",
    label: "Freshness",
    title: "Age of the last good data, against how long it may go before it counts as late",
  },
  { key: "lastGood", label: "Last good data" },
  { key: "duration", label: "Took", title: "How long the most recent attempt took", right: true },
];

type OriginFilter = "all" | "external" | "internal";

const ORIGIN_OPTIONS: ReadonlyArray<{ value: OriginFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "external", label: "External" },
  { value: "internal", label: "Internal" },
];

/** Same units the Took column prints, summed across a group. */
export function formatTotal(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** Freshness bar fill: amber once the data is most of the way to counting as late. */
const NEAR_LATE = 0.85;

const thClass =
  "text-muted-foreground px-3 py-2.5 text-[11.5px] font-medium tracking-[0.06em] uppercase first:pl-[18px] last:pr-[18px]";
const tdClass = "px-3 py-2.5 align-middle first:pl-[18px] last:pr-[18px]";

export function RunningNormally({
  rows,
  summaryLine,
  sortKey,
  sortDir,
}: {
  rows: NormalRow[];
  /** "All 47 up to date. Oldest data: …" — composed on the server. */
  summaryLine: string;
  sortKey: NormalSortKey | null;
  sortDir: NormalSortDir;
}) {
  const [query, setQuery] = React.useState("");
  const [origin, setOrigin] = React.useState<OriginFilter>("all");
  const [open, setOpen] = React.useState(true);

  const q = query.trim().toLowerCase();
  const visible = rows.filter(
    (r) =>
      (origin === "all" || r.origin === origin) &&
      (q === "" || `${r.label} ${r.source} ${r.description ?? ""}`.toLowerCase().includes(q)),
  );
  const groups = GROUPS.map((g) => ({
    ...g,
    rows: visible.filter((r) => r.group === g.key),
  })).filter((g) => g.rows.length > 0);

  return (
    <section className="flex flex-col gap-3" id="etl-status-normal" data-testid="etl-status-normal">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="m-0 text-lg font-semibold">Running normally</h2>
        <span className="text-muted-foreground text-[13px]" data-testid="etl-status-normal-summary">
          {summaryLine}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="etl-status-normal-body"
          className="text-apollo-slate text-[13px] underline"
          data-testid="etl-status-normal-toggle"
        >
          {open ? "Hide" : "Show"}
        </button>
        {open && rows.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2.5 sm:ml-auto">
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Import or source…"
              aria-label="Filter imports by name or source"
              className="border-apollo-border-strong h-[34px] w-[200px] text-[13.5px] md:text-[13.5px]"
              data-testid="etl-status-filter"
            />
            <div
              role="radiogroup"
              aria-label="Where the data comes from"
              className="border-apollo-border bg-apollo-surface-2 inline-flex rounded-lg border p-[3px]"
              data-testid="etl-status-origin-filter"
            >
              {ORIGIN_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={origin === o.value}
                  onClick={() => setOrigin(o.value)}
                  data-testid={`etl-status-origin-${o.value}`}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[13px] whitespace-nowrap",
                    origin === o.value
                      ? "bg-apollo-surface text-foreground shadow-xs"
                      : "text-muted-foreground",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div id="etl-status-normal-body" hidden={!open} className="flex flex-col gap-3">
        {rows.length === 0 ? null : (
          <div className="border-apollo-border-strong bg-apollo-surface overflow-x-auto rounded-[13px] border">
            <table
              className="w-full min-w-[720px] border-collapse text-sm"
              data-testid="etl-status-table"
            >
              <thead className="bg-apollo-surface-2 border-apollo-border-strong border-b text-left">
                <tr>
                  {COLUMNS.map((col) => (
                    <SortableHeader key={col.key} col={col} sortKey={sortKey} sortDir={sortDir} />
                  ))}
                </tr>
              </thead>
              {groups.map((g) => (
                <GroupBody key={g.key} label={g.label} rows={g.rows} />
              ))}
            </table>
            {groups.length === 0 ? (
              <p
                className="text-muted-foreground m-0 p-7 text-center text-sm"
                data-testid="etl-status-no-match"
              >
                No imports match.
              </p>
            ) : null}
          </div>
        )}
        <p className="text-muted-foreground m-0 max-w-[100ch] text-[12.5px] leading-normal">
          &ldquo;Last good data&rdquo; is when the information itself was produced, which
          isn&rsquo;t always when the import last ran: some imports check for changes and finish
          without replacing anything. The freshness bar fills as data ages toward the point it would
          count as late. &ldquo;&mdash;&rdquo; under Took means no start time has been logged yet.
        </p>
      </div>
    </section>
  );
}

/** One clickable column header — a real `?sort=` navigation the server re-sorts on. */
function SortableHeader({
  col,
  sortKey,
  sortDir,
}: {
  col: (typeof COLUMNS)[number];
  sortKey: NormalSortKey | null;
  sortDir: NormalSortDir;
}) {
  const active = sortKey === col.key;
  const nextDir: NormalSortDir = active && sortDir === "asc" ? "desc" : "asc";
  return (
    <th
      scope="col"
      className={cn(thClass, col.right && "text-right")}
      title={col.title}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <a href={`?sort=${col.key}&dir=${nextDir}`} className="whitespace-nowrap hover:underline">
        {col.label}
        {/* Plain "^"/"v", not a filled triangle — a light directional mark. */}
        {active ? <span aria-hidden="true">{sortDir === "asc" ? " ^" : " v"}</span> : null}
      </a>
    </th>
  );
}

function GroupBody({ label, rows }: { label: string; rows: NormalRow[] }) {
  const measured = rows.map((r) => r.tookMs).filter((v): v is number => v !== null);
  const missing = rows.length - measured.length;
  const total = measured.reduce((a, b) => a + b, 0);
  return (
    <tbody data-testid={`etl-status-group-${label.toLowerCase()}`}>
      <tr className="bg-apollo-page border-apollo-border-strong border-t">
        <th
          scope="colgroup"
          colSpan={COLUMNS.length}
          className="px-[18px] py-2 text-left font-normal"
        >
          <span className="text-[12.5px] font-semibold tracking-[0.06em] uppercase">{label}</span>
          <span className="text-muted-foreground ml-2.5 text-[12.5px]">{rows.length}</span>
        </th>
      </tr>
      {rows.map((r) => (
        <tr
          key={r.source}
          className="border-apollo-border hover:bg-apollo-page border-t"
          data-testid={`etl-status-row-${r.source}`}
          data-state="up-to-date"
        >
          <td className={tdClass}>
            <span className="block text-sm font-medium">{r.label}</span>
            {r.description === null ? null : (
              <span
                className="text-muted-foreground mt-0.5 block text-[12.5px] leading-snug"
                data-testid="etl-status-description"
              >
                {r.description}
              </span>
            )}
          </td>
          <td className={cn(tdClass, "max-w-[220px]")}>
            <span className="flex min-w-0 items-center gap-1.5">
              {r.origin === null ? null : (
                <span
                  className="bg-apollo-surface-2 text-muted-foreground flex-none rounded px-1.5 py-px text-[10.5px] font-semibold tracking-[0.05em] uppercase"
                  title={r.origin === "external" ? "External" : "Internal"}
                  data-testid="etl-status-origin"
                >
                  <span aria-hidden="true">{r.origin === "external" ? "Ext" : "Int"}</span>
                  <span className="sr-only">
                    {r.origin === "external" ? "External" : "Internal"}
                  </span>
                </span>
              )}
              <span
                className="text-muted-foreground truncate font-mono text-xs"
                title={r.source}
                data-testid="etl-status-source-key"
              >
                {r.source}
              </span>
            </span>
          </td>
          <td className={cn(tdClass, "w-[150px]")} title={r.freshTip}>
            <span className="flex flex-col gap-1">
              <span
                className="bg-apollo-surface-2 block h-1.5 overflow-hidden rounded-full"
                aria-hidden="true"
              >
                <span
                  className={cn(
                    "block h-full rounded-full",
                    (r.fraction ?? 0) > NEAR_LATE ? "bg-apollo-amber" : "bg-apollo-slate",
                  )}
                  style={{ width: `${Math.max(3, Math.min(1, r.fraction ?? 0) * 100)}%` }}
                  data-testid="etl-status-freshness"
                />
              </span>
              <span className="text-muted-foreground text-xs">{r.ago}</span>
            </span>
          </td>
          <td className={cn(tdClass, "w-[130px] text-[13px] whitespace-nowrap tabular-nums")}>
            {r.lastGood}
          </td>
          <td
            className={cn(
              tdClass,
              "w-[80px] text-right text-[13px] whitespace-nowrap tabular-nums",
              r.took === "—" ? "text-apollo-border-strong" : "text-foreground",
            )}
          >
            {r.took}
          </td>
        </tr>
      ))}
      <tr className="bg-apollo-page border-apollo-border-strong text-muted-foreground border-t text-[12.5px]">
        <td className="py-2 pl-[18px]" colSpan={COLUMNS.length - 1}>
          Total run time, {rows.length} import{rows.length === 1 ? "" : "s"}
          {missing > 0 ? ` (${missing} not recorded)` : ""}
        </td>
        <td className="text-foreground py-2 pr-[18px] text-right font-semibold whitespace-nowrap tabular-nums">
          {measured.length === 0 ? "—" : formatTotal(total)}
        </td>
      </tr>
    </tbody>
  );
}
