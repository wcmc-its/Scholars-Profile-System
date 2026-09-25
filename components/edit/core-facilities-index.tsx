/**
 * CoreFacilitiesIndex — the `/edit/core` "Core facilities" table: KPI tiles
 * that double as filters, a free-text filter, a sortable per-core table and an
 * expandable detail row per core (leaders, owners & curators, public-page
 * state, staff feed) with links into the review queue and the core editor.
 *
 * Pure presentation over `CoreConsoleRow` (lib/api/core-console-index.ts); the
 * derived states (`deriveCoreState`) are exported for unit tests.
 *
 * Below `lg` the table collapses to stacked rows (phones use /edit): the column
 * header is hidden and each numeric cell carries its own label.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Input } from "@/components/ui/input";
import type { CoreConsoleRow } from "@/lib/api/core-console-index";
import { cn } from "@/lib/utils";

export type CoreFilter = "review" | "hidden" | "problem";
type SortKey = "name" | "status" | "review" | "confirmed" | "clients" | "staff";

export interface DerivedCore extends CoreConsoleRow {
  isPublic: boolean;
  /** Why a core is hidden ("" when public). */
  hiddenWhy: string;
  noFeed: boolean;
  dataProblem: boolean;
  reviewOther: number;
}

/**
 * Public only when the per-core toggle AND every public-surface flag is on.
 * A data problem is a core the review engine can't serve well: no staff feed,
 * listed staff of whom none are tracked, or no owner to do the review.
 */
export function deriveCoreState(c: CoreConsoleRow, offFlags: readonly string[]): DerivedCore {
  const isPublic = c.visible && offFlags.length === 0;
  const noFeed = c.staffListed == null;
  const untrackedAll = !noFeed && (c.staffListed ?? 0) > 0 && (c.staffTracked ?? 0) === 0;
  return {
    ...c,
    isPublic,
    hiddenWhy: isPublic ? "" : !c.visible ? "Core toggle off" : `${offFlags[0]} off`,
    noFeed,
    dataProblem: noFeed || untrackedAll || c.owners.length === 0,
    reviewOther: c.reviewTotal - c.reviewHigh,
  };
}

const FILTER_TESTS: Record<CoreFilter, (c: DerivedCore) => boolean> = {
  review: (c) => c.reviewTotal > 0,
  hidden: (c) => !c.isPublic,
  problem: (c) => c.dataProblem,
};

const FILTER_LABELS: Record<CoreFilter, string> = {
  review: "Needs review",
  hidden: "Hidden",
  problem: "Data problems",
};

const fmt = (n: number) => n.toLocaleString("en-US");

function sortValue(c: DerivedCore, key: SortKey): number {
  switch (key) {
    case "status":
      return c.isPublic ? 1 : 0;
    case "review":
      // High-confidence first, total as the tie-break.
      return c.reviewHigh * 1e6 + c.reviewTotal;
    case "confirmed":
      return c.confirmed;
    case "clients":
      return c.clientsWithCwid + c.clientsNameOnly;
    case "staff":
      return c.staffTracked ?? -1;
    default:
      return 0;
  }
}

/** Staff cell text + the secondary warning line under it. */
function staffCell(c: DerivedCore): {
  main: string;
  sub: string;
  mainWarn: boolean;
  subWarn: boolean;
} {
  if (c.noFeed) return { main: "Not listed", sub: "No staff feed", mainWarn: true, subWarn: true };
  const listed = c.staffListed ?? 0;
  const tracked = c.staffTracked ?? 0;
  if (listed === 0) return { main: "None listed", sub: "", mainWarn: true, subWarn: false };
  if (tracked === 0)
    return {
      main: `0 of ${listed}`,
      sub: "Co-author signal can’t fire",
      mainWarn: false,
      subWarn: true,
    };
  if (tracked < listed)
    return {
      main: `${tracked} of ${listed}`,
      sub: `${listed - tracked} untracked`,
      mainWarn: false,
      subWarn: true,
    };
  return { main: `${tracked} of ${listed}`, sub: "tracked", mainWarn: false, subWarn: false };
}

const COLS = "lg:grid-cols-[minmax(0,1.6fr)_100px_minmax(0,1.1fr)_88px_76px_92px_116px_20px]";

const HEADS: ReadonlyArray<{
  key: SortKey | null;
  label: string;
  align: "left" | "right";
  tip?: string;
}> = [
  { key: "name", label: "Core", align: "left" },
  {
    key: "status",
    label: "Status",
    align: "left",
    tip: "Public only when the core toggle, CORE_PAGES and CORE_PUB_MODAL are all on",
  },
  { key: null, label: "Leaders", align: "left" },
  {
    key: "review",
    label: "To review",
    align: "right",
    tip: "Engine candidates with no active claim. High = likelihood ≥ 80%",
  },
  { key: "confirmed", label: "Confirmed", align: "right", tip: "After owners’ claims" },
  {
    key: "clients",
    label: "Clients",
    align: "right",
    tip: "Active clients: with CWID + name-only",
  },
  {
    key: "staff",
    label: "Staff listed",
    align: "right",
    tip: "Whether a staff list is published, and how many the co-author signal can match",
  },
];

export interface CoreFacilitiesIndexProps {
  cores: CoreConsoleRow[];
  /** Public-surface env flags that are currently OFF (e.g. "CORE_PAGES"). */
  offFlags: string[];
}

export function CoreFacilitiesIndex({ cores, offFlags }: CoreFacilitiesIndexProps) {
  const [filter, setFilter] = React.useState<CoreFilter | null>(null);
  const [q, setQ] = React.useState("");
  const [sortKey, setSortKey] = React.useState<SortKey>("review");
  const [sortDir, setSortDir] = React.useState<1 | -1>(-1);
  const [open, setOpen] = React.useState<Record<string, boolean>>({});

  const all = React.useMemo(
    () => cores.map((c) => deriveCoreState(c, offFlags)),
    [cores, offFlags],
  );

  const needle = q.trim().toLowerCase();
  const list = all
    .filter((c) => !filter || FILTER_TESTS[filter](c))
    .filter(
      (c) =>
        !needle ||
        [c.name, c.facility ?? "", ...c.leaders.map((l) => l.name)]
          .join(" ")
          .toLowerCase()
          .includes(needle),
    )
    .sort((a, b) =>
      sortKey === "name"
        ? a.name.localeCompare(b.name) * sortDir
        : (sortValue(a, sortKey) - sortValue(b, sortKey)) * sortDir || a.name.localeCompare(b.name),
    );

  const totalReview = all.reduce((n, c) => n + c.reviewTotal, 0);
  const totalHigh = all.reduce((n, c) => n + c.reviewHigh, 0);
  const totalConfirmed = all.reduce((n, c) => n + c.confirmed, 0);
  const publicCount = all.filter((c) => c.isPublic).length;

  const kpis: ReadonlyArray<{
    key: CoreFilter | null;
    label: string;
    value: string;
    sub: string;
    ink?: string;
  }> = [
    {
      key: "review",
      label: "To review",
      value: fmt(totalReview),
      sub: `${fmt(totalHigh)} high confidence · ${all.filter(FILTER_TESTS.review).length} cores`,
      ink: "text-apollo-slate",
    },
    {
      key: null,
      label: "Confirmed publications",
      value: fmt(totalConfirmed),
      sub: "after owners’ claims",
    },
    {
      key: "hidden",
      label: "Hidden cores",
      value: String(all.filter(FILTER_TESTS.hidden).length),
      sub: offFlags.length
        ? `${offFlags.join(", ")} ${offFlags.length > 1 ? "are" : "is"} off`
        : `of ${all.length}; public ones: ${publicCount}`,
    },
    {
      key: "problem",
      label: "Data problems",
      value: String(all.filter(FILTER_TESTS.problem).length),
      sub: "no staff feed, untracked staff or no owner",
      ink: "text-apollo-amber",
    },
  ];

  const onSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(key === "name" ? 1 : -1);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="core-kpis">
        {kpis.map((k) => {
          const active = k.key != null && filter === k.key;
          const body = (
            <>
              <span className="text-muted-foreground text-xs font-medium tracking-[.08em] uppercase">
                {k.label}
              </span>
              <span
                className={cn(
                  "text-[28px] leading-tight font-semibold tracking-[-0.01em] tabular-nums",
                  k.ink ?? "text-foreground",
                )}
              >
                {k.value}
              </span>
              <span className="text-muted-foreground text-[12.5px]">{k.sub}</span>
            </>
          );
          const tile =
            "bg-apollo-surface flex flex-col gap-[3px] rounded-[13px] border px-4 py-3.5 text-left";
          return k.key ? (
            <button
              key={k.label}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(active ? null : k.key)}
              className={cn(
                tile,
                "cursor-pointer transition-shadow",
                active
                  ? "border-apollo-slate ring-apollo-slate-tint ring-[3px]"
                  : "border-apollo-border-strong hover:border-apollo-slate-tint-border",
              )}
            >
              {body}
            </button>
          ) : (
            <div key={k.label} className={cn(tile, "border-apollo-border-strong")}>
              {body}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-muted-foreground text-sm" data-testid="core-showing">
          {list.length} of {all.length} cores
        </span>
        {filter && (
          <span className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate inline-flex items-center gap-1.5 rounded-full border py-[3px] pr-1.5 pl-2.5 text-[13px]">
            {FILTER_LABELS[filter]}
            <button
              type="button"
              onClick={() => setFilter(null)}
              aria-label={`Clear the ${FILTER_LABELS[filter]} filter`}
              className="text-apollo-slate cursor-pointer px-1 text-sm leading-none"
            >
              ×
            </button>
          </span>
        )}
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Core, facility or leader…"
          aria-label="Filter cores by core, facility or leader"
          className="border-apollo-border-strong h-[34px] w-full sm:ml-auto sm:w-[220px]"
        />
      </div>

      <div
        className="bg-apollo-surface border-apollo-border-strong overflow-hidden rounded-[13px] border"
        data-testid="edit-cores-list"
      >
        <div
          className={cn(
            "bg-apollo-surface-2 border-apollo-border-strong text-muted-foreground hidden items-end gap-3 border-b px-[18px] py-2.5 text-[11.5px] font-medium tracking-[.06em] uppercase lg:grid",
            COLS,
          )}
        >
          {HEADS.map((h) =>
            h.key ? (
              <button
                key={h.label}
                type="button"
                title={h.tip}
                onClick={() => onSort(h.key as SortKey)}
                aria-label={`Sort by ${h.label}`}
                className={cn(
                  "cursor-pointer leading-[1.3] uppercase",
                  h.align === "right" ? "text-right" : "text-left",
                  sortKey === h.key ? "text-foreground font-semibold" : "font-medium",
                )}
              >
                {h.label}
                {sortKey === h.key ? (sortDir < 0 ? " ↓" : " ↑") : ""}
              </button>
            ) : (
              <span key={h.label} title={h.tip}>
                {h.label}
              </span>
            ),
          )}
          <span aria-hidden />
        </div>

        {list.map((c, i) => (
          <CoreRow
            key={c.id}
            core={c}
            first={i === 0}
            open={!!open[c.id]}
            onToggle={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}
          />
        ))}
        {list.length === 0 && (
          <div className="text-muted-foreground p-7 text-center text-sm">No cores match.</div>
        )}
      </div>

      <p className="text-muted-foreground max-w-[100ch] text-[12.5px] leading-normal">
        Confirmed counts apply owners’ claims on top of the engine. “To review” is engine candidates
        with no active claim, split into high confidence (likelihood ≥ 80%) and other. Staff listed
        shows how many listed staff are tracked, the ones the co-author signal can match. “Not
        listed” means the staff feed hasn’t been published yet, which is different from none.
      </p>
    </div>
  );
}

function MobileLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground text-[11px] font-medium tracking-[.06em] uppercase lg:hidden">
      {children}
    </span>
  );
}

function CoreRow({
  core: c,
  first,
  open,
  onToggle,
}: {
  core: DerivedCore;
  first: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const detailsId = `core-details-${c.id}`;
  const staff = staffCell(c);
  const clients = c.clientsWithCwid + c.clientsNameOnly;
  const reviewHref = `/edit/core/${encodeURIComponent(c.id)}/review`;
  const editHref = `/edit/core/${encodeURIComponent(c.id)}`;
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div className={cn(!first && "border-apollo-border border-t")} data-testid="core-row">
      <div
        onClick={onToggle}
        className={cn(
          "hover:bg-apollo-page grid cursor-pointer grid-cols-3 items-center gap-x-3 gap-y-2 px-[18px] py-3 lg:gap-3",
          COLS,
          open ? "bg-apollo-page" : "bg-apollo-surface",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="col-span-3 flex min-w-0 cursor-pointer items-start gap-2 text-left lg:col-span-1"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="text-[14.5px] font-semibold">{c.name}</span>
              <span className="text-muted-foreground font-mono text-[11.5px]">#{c.id}</span>
            </span>
            <span className="text-muted-foreground truncate text-[12.5px]">
              {c.facility || "No facility name"}
            </span>
          </span>
          <span className="text-muted-foreground text-xs lg:hidden" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        </button>

        <div className="col-span-2 flex flex-col items-start gap-0.5 lg:col-span-1">
          <span
            className={cn(
              "rounded-full border px-[9px] py-0.5 text-xs font-semibold",
              c.isPublic
                ? "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border"
                : "bg-apollo-surface-2 text-muted-foreground border-apollo-border-strong",
            )}
          >
            {c.isPublic ? "Public" : "Hidden"}
          </span>
          {c.hiddenWhy && (
            <span className="text-muted-foreground text-[11.5px]">{c.hiddenWhy}</span>
          )}
        </div>

        <span
          className={cn(
            "order-1 col-span-3 min-w-0 text-[13px] leading-snug lg:order-none lg:col-span-1",
            c.leaders.length ? "text-foreground" : "text-apollo-amber",
          )}
        >
          <MobileLabel>Leaders </MobileLabel>
          {c.leaders.length
            ? c.leaders.map((l) => l.name + (l.interim ? " (interim)" : "")).join(", ")
            : "No leader set"}
        </span>

        <div className="flex justify-end">
          {c.reviewTotal > 0 ? (
            <Link
              href={reviewHref}
              onClick={stop}
              title={`${c.reviewHigh} high-confidence (likelihood ≥ 80%) · ${c.reviewOther} lower`}
              className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate hover:bg-apollo-slate hover:border-apollo-slate flex flex-col items-end rounded-[7px] border px-2 py-1 hover:text-white hover:no-underline"
            >
              <span className="text-sm font-semibold whitespace-nowrap tabular-nums">
                {fmt(c.reviewHigh)} high →
              </span>
              <span className="text-[11px] whitespace-nowrap opacity-80">
                +{fmt(c.reviewOther)} other
              </span>
            </Link>
          ) : (
            <span className="text-apollo-border-strong text-sm tabular-nums">
              {c.noFeed ? "—" : "0"}
            </span>
          )}
        </div>

        <div className="flex flex-col lg:items-end">
          <MobileLabel>Confirmed</MobileLabel>
          <span className="text-sm tabular-nums">{fmt(c.confirmed)}</span>
        </div>

        <div
          className="flex flex-col gap-px lg:items-end"
          title={`${c.clientsWithCwid} with CWID · ${c.clientsNameOnly} name-only`}
        >
          <MobileLabel>Clients</MobileLabel>
          <span className="text-sm tabular-nums">{fmt(clients)}</span>
          {c.clientsNameOnly > 0 && (
            <span className="text-muted-foreground text-[11.5px] whitespace-nowrap">
              +{c.clientsNameOnly} name-only
            </span>
          )}
        </div>

        <div className="flex flex-col gap-px lg:items-end">
          <MobileLabel>Staff listed</MobileLabel>
          <span className={cn("text-sm tabular-nums", staff.mainWarn && "text-apollo-amber")}>
            {staff.main}
          </span>
          {staff.sub && (
            <span
              className={cn(
                "text-[11.5px] whitespace-nowrap",
                staff.subWarn ? "text-apollo-amber" : "text-muted-foreground",
              )}
            >
              {staff.sub}
            </span>
          )}
        </div>

        <span className="text-muted-foreground hidden text-right text-xs lg:block" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </div>

      {open && <CoreDetails core={c} id={detailsId} reviewHref={reviewHref} editHref={editHref} />}
    </div>
  );
}

type Line = { t: string; sub?: string; warn?: boolean; muted?: boolean };

function CoreDetails({
  core: c,
  id,
  reviewHref,
  editHref,
}: {
  core: DerivedCore;
  id: string;
  reviewHref: string;
  editHref: string;
}) {
  const staffGap =
    !c.noFeed && (c.staffListed ?? 0) > 0 && (c.staffTracked ?? 0) < (c.staffListed ?? 0);
  const details: ReadonlyArray<{ k: string; lines: Line[] }> = [
    {
      k: "Leaders",
      lines: c.leaders.length
        ? c.leaders.map((l) => ({ t: l.name, sub: ` · ${l.role}${l.interim ? ", interim" : ""}` }))
        : [{ t: "None. Add one in the core editor.", warn: true }],
    },
    {
      k: "Owners & curators",
      lines: [
        ...c.owners.map((n) => ({ t: n, sub: " · owner" })),
        ...c.curators.map((n) => ({ t: n, sub: " · curator" })),
        ...(c.owners.length
          ? []
          : [{ t: "No owner. A Superuser needs to grant one.", warn: true }]),
      ],
    },
    {
      k: "Public page",
      lines: [
        { t: c.visible ? "Core toggle on" : "Core toggle off" },
        { t: c.hasUrl ? "URL set" : "No URL", muted: !c.hasUrl },
        {
          t: c.hasDescription ? "Description written" : "No description",
          muted: !c.hasDescription,
        },
      ],
    },
    {
      k: "Staff feed",
      lines: c.noFeed
        ? [{ t: "Not published yet (STAFF_DICT missing)", muted: true }]
        : [
            { t: `${c.staffTracked ?? 0} of ${c.staffListed ?? 0} staff tracked` },
            ...(staffGap
              ? [
                  {
                    t: "Add staff CWIDs to the dictionary so the co-author signal can match them.",
                    warn: true,
                  },
                ]
              : []),
          ],
    },
  ];

  return (
    <div
      id={id}
      className="bg-apollo-page border-apollo-border grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-7 gap-y-3 border-t border-dashed px-[18px] pt-1 pb-4"
    >
      <div className="col-span-full flex flex-wrap items-center gap-2.5 pt-3">
        <Link
          href={c.reviewTotal > 0 ? reviewHref : editHref}
          className="bg-apollo-slate hover:bg-apollo-notice-text inline-flex h-8 items-center rounded-[7px] px-3.5 text-[13px] font-medium text-white hover:text-white hover:no-underline"
        >
          {c.reviewTotal > 0 ? `Review ${fmt(c.reviewTotal)} suggestions →` : "Open core →"}
        </Link>
        <Link href={editHref} className="text-apollo-slate text-[13px]">
          Edit core
        </Link>
      </div>
      {details.map((d) => (
        <div key={d.k} className="flex flex-col gap-1 pt-2.5">
          <span className="text-muted-foreground text-[11.5px] font-medium tracking-[.1em] uppercase">
            {d.k}
          </span>
          {d.lines.map((l, i) => (
            <span
              key={i}
              className={cn(
                "text-[13.5px] leading-[1.45]",
                l.warn
                  ? "text-apollo-amber"
                  : l.muted
                    ? "text-muted-foreground"
                    : "text-foreground",
              )}
            >
              {l.t}
              {l.sub && <span className="text-muted-foreground">{l.sub}</span>}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
