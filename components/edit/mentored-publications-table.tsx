"use client";

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { useShowMore } from "@/components/edit/reports/report-show-more";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Button } from "@/components/ui/button";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { citationIdentifier } from "@/lib/citation";
import type {
  MentoredPubsLearnerOnPub,
  MentoredPubsPublicationRow,
  MentoredPubsSummaryRow,
  MentorPair,
  MentorRef,
} from "@/lib/edit/mentored-publications-report";
import {
  MENTORSHIP_TYPE_DESCRIPTION,
  mentorshipKey,
  mentorshipLabel,
  mentorshipTypeKey,
  type MentorshipType,
} from "@/lib/edit/mentorship-type";

/**
 * Report 7's results as a client island (reports redesign, 2026-09-24; mockup
 * `Pub Reports/Mentored Publications Redesign.dc.html`): the Learners (N) /
 * Publications (N) tabs, the "Find a learner or mentor" box, the tables and
 * "Show 25 more". Everything that FILTERS lives in the body's rail (URL
 * params, a server round trip, applied before the rows reach this island);
 * what stays here is what never changes a count: the tab, the find box, the
 * sort and paging.
 *
 * Learners: Learner (name, CWID, "Grad YYYY") · Mentors (each mentor's name
 * with the pair's type as a badge, "Department · Institution" under it) · In
 * window · [With a mentor, all-publications set only] · All years ·
 * JIF ≥ 10 · First author. The old table's separate Grad year / Type /
 * Department / Institution columns made it wider than the page and scrolled
 * the Learner column out of view (the 2026-09-24 bug); below `md` the mentor
 * lines and the numbers stack inside the Learner cell instead, so a 390px
 * page never scrolls sideways. A row with publications opens (row click or
 * its chevron button) to that learner's papers. "—" (never 0) wherever the
 * learner's window is unknowable, as in the loader and the workbook. Sort by
 * the header buttons (`aria-sort` on the active one; clicking it flips);
 * nulls sort last either way.
 *
 * Publications: one entry per distinct paper (the Vancouver citation and its
 * PMID link, JIF, NIH iCite citations, date added to PubMed, then each
 * learner with their byline position and window badge, and each mentor with
 * the pair's type) — a list, not the old seven-column table, for the same
 * width reason. Sort select: date added to PubMed (default, the loader's
 * order), publication year, JIF, citations, title.
 *
 * Tabs: both views ride on the same loaded rows, so a click swaps the view in
 * state and rewrites the URL (`history.replaceState`); without JS the tab is
 * a plain link. The current view and find text reach the rail's GET forms as
 * hidden inputs bound by `form=` to each form id (the desktop rail and the
 * phone sheet's copy), so a filter change keeps them.
 */

type View = "summary" | "publications";

const TH = "text-muted-foreground px-3 py-2.5 align-bottom text-xs font-semibold tracking-[0.08em] uppercase";
const TD = "px-3 py-3 align-top";
const NUM_TD = `${TD} text-right tabular-nums hidden md:table-cell`;
const TAB_ACTIVE = "border-apollo-maroon text-foreground -mb-px border-b-2 py-2.5 text-base font-semibold";
const TAB_IDLE =
  "text-muted-foreground hover:text-foreground -mb-px border-b-2 border-transparent py-2.5 text-base";

const learnerName = (l: { firstName: string | null; lastName: string | null }) =>
  [l.lastName, l.firstName].filter(Boolean).join(", ");

// ---- sorting ----------------------------------------------------------------

type SortDir = "asc" | "desc";
type SortCol<Row> = { key: string; get: (row: Row) => number | string | null; dir: SortDir };

/** Nulls last in BOTH directions. */
function compareNullsLast(a: number | string | null, b: number | string | null, dir: SortDir): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const c =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), "en", { sensitivity: "base" });
  return dir === "asc" ? c : -c;
}

function sortRows<Row>(rows: readonly Row[], col: SortCol<Row>, dir: SortDir): Row[] {
  // Stable, so the loader's own order breaks ties.
  return [...rows].sort((a, b) => compareNullsLast(col.get(a), col.get(b), dir));
}

// ---- shared pieces ------------------------------------------------------------

/** One pair's type as a badge, hovering its category's description (the
 *  rail checkbox hovers the same sentence). Inferred pairs read amber. */
function TypeBadge({ type }: { type: MentorshipType }) {
  const key = mentorshipTypeKey(type);
  const inferred = type.source === "coauthor";
  const badge = (
    <span
      className={`rounded border px-1.5 text-xs leading-5 ${
        inferred ? "bg-apollo-amber-tint border-apollo-amber-tint-border" : "bg-apollo-surface-2 border-apollo-border"
      }`}
    >
      {mentorshipLabel(type)}
    </span>
  );
  return key === null ? badge : <HoverTooltip text={MENTORSHIP_TYPE_DESCRIPTION[key]} wide>{badge}</HoverTooltip>;
}

/** "Department · Institution", "—" when neither is known. */
function where(m: MentorRef): string {
  return [m.department, m.institution].filter(Boolean).join(" · ") || "—";
}

function MentorList({ mentors }: { mentors: ReadonlyArray<MentorPair> }) {
  if (mentors.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {mentors.map((m) => (
        <li key={m.cwid}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <ScholarHoverCard cwid={m.cwid}>
              <span className="font-medium hover:underline">{m.name}</span>
            </ScholarHoverCard>
            <TypeBadge type={m.mentorship} />
          </div>
          <div className="text-muted-foreground mt-px text-[13px]">{where(m)}</div>
        </li>
      ))}
    </ul>
  );
}

const WINDOW_BADGE: Record<"yes" | "no" | "unknown", { label: string; className: string }> = {
  yes: { label: "In window", className: "bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate" },
  no: { label: "Outside window", className: "bg-apollo-surface-2 border-apollo-border-strong" },
  unknown: { label: "Window unknown", className: "bg-apollo-surface-2 border-apollo-border-strong" },
};

function WindowBadge({ inWindow }: { inWindow: boolean | null }) {
  const b = WINDOW_BADGE[inWindow === null ? "unknown" : inWindow ? "yes" : "no"];
  return (
    <span
      className={`rounded border px-1.5 text-xs leading-5 whitespace-nowrap ${b.className}`}
      title={inWindow === null ? "No graduation or entry year on record, so no window to count against" : undefined}
    >
      {b.label}
    </span>
  );
}

function positionLabel(l: MentoredPubsLearnerOnPub, authorCount: number): string | null {
  if (l.authorPosition === null) return null;
  if (l.authorPosition === 1) return "1st author";
  if (l.authorPosition === authorCount) return "last author";
  return null;
}

/** One publication: citation + identifier, the numbers, then who is on it.
 *  `focus` (a learner's expanded row) shows only that learner's badge. */
function PubItem({
  p,
  allMode,
  focus,
}: {
  p: MentoredPubsPublicationRow;
  allMode: boolean;
  focus?: string;
}) {
  const id = citationIdentifier(p.pmid);
  const learners = focus ? p.learners.filter((l) => l.cwid === focus) : p.learners;
  return (
    <li className="border-apollo-border flex flex-col gap-1.5 border-b py-3.5 last:border-b-0" data-testid={`mentored-pubs-pub-${p.pmid}`}>
      <p className="text-[15px] leading-snug">
        {p.citation}{" "}
        <span className="whitespace-nowrap">
          {id.label}:{" "}
          {id.href ? (
            <a href={id.href} target="_blank" rel="noopener noreferrer" className="text-apollo-slate hover:underline">
              {id.value}
            </a>
          ) : (
            id.value
          )}
        </span>
      </p>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
        {focus && learners[0] && <WindowBadge inWindow={learners[0].inWindow} />}
        <span>JIF {p.jif ?? "—"}</span>
        <span>{p.citations === null ? "Citations —" : p.citations === 1 ? "1 citation" : `${p.citations} citations`}</span>
        <span>Added to PubMed {p.dateAdded ? p.dateAdded.toISOString().slice(0, 10) : "—"}</span>
      </div>
      <dl className="m-0 flex flex-col gap-1 text-[13px]">
        {!focus && (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">{learners.length === 1 ? "Learner:" : "Learners:"}</dt>
            <dd className="m-0 flex flex-wrap gap-x-4 gap-y-1">
              {learners.map((l) => {
                const pos = positionLabel(l, p.authorCount);
                return (
                  <span key={l.cwid} className="inline-flex flex-wrap items-center gap-x-1.5">
                    <ScholarHoverCard cwid={l.cwid}>
                      <span className="font-medium hover:underline">{learnerName(l)}</span>
                    </ScholarHoverCard>
                    <span className="text-muted-foreground font-mono text-xs">{l.cwid}</span>
                    {pos && <span className="text-muted-foreground">{pos}</span>}
                    <WindowBadge inWindow={l.inWindow} />
                  </span>
                );
              })}
            </dd>
          </div>
        )}
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-muted-foreground">{p.mentors.length === 1 ? "Mentor:" : "Mentors:"}</dt>
          <dd className="m-0 flex flex-wrap gap-x-4 gap-y-1">
            {allMode && !p.withMentor ? (
              <span className="text-muted-foreground">No mentor co-author</span>
            ) : p.mentors.length === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              p.mentors.map((m) => (
                <span key={m.cwid} className="inline-flex flex-wrap items-center gap-x-1.5">
                  <ScholarHoverCard cwid={m.cwid}>
                    <span className="font-medium hover:underline">{m.name}</span>
                  </ScholarHoverCard>
                  {m.mentorships.map((t) => (
                    <TypeBadge key={mentorshipKey(t)} type={t} />
                  ))}
                </span>
              ))
            )}
          </dd>
        </div>
      </dl>
    </li>
  );
}

function ShowMoreRow({
  label,
  hasMore,
  onMore,
  testId,
}: {
  label: string;
  hasMore: boolean;
  onMore: () => void;
  testId: string;
}) {
  return (
    <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3">
      <span className="text-muted-foreground text-[13px]" data-testid={`${testId}-range`}>
        {label}
      </span>
      {hasMore && (
        <Button type="button" variant="outline" size="sm" onClick={onMore} data-testid={`${testId}-more`}>
          Show 25 more
        </Button>
      )}
    </div>
  );
}

// ---- Learners ------------------------------------------------------------------

const num = (key: string, get: (r: MentoredPubsSummaryRow) => number | null): SortCol<MentoredPubsSummaryRow> => ({
  key,
  get,
  dir: "desc",
});
const LEARNER_COLS: Record<string, SortCol<MentoredPubsSummaryRow>> = {
  grad: num("grad", (r) => r.gradYear),
  learner: { key: "learner", get: (r) => learnerName(r) || null, dir: "asc" },
  win: num("win", (r) => r.pubsInWindow),
  withMentor: num("withMentor", (r) => r.withMentorInWindow),
  all: num("all", (r) => r.pubsAllTime),
  if10: num("if10", (r) => r.highImpactInWindow),
  first: num("first", (r) => r.firstAuthorInWindow),
};

type SortState = { key: string; dir: SortDir };

function SortButton({
  col,
  sort,
  onSort,
  title,
  children,
}: {
  col: SortCol<MentoredPubsSummaryRow>;
  sort: SortState;
  onSort: (key: string) => void;
  title?: string;
  children: React.ReactNode;
}) {
  const active = sort.key === col.key;
  return (
    <button
      type="button"
      onClick={() => onSort(col.key)}
      title={title}
      className="inline-flex cursor-pointer items-end gap-1 text-inherit uppercase hover:underline"
    >
      {children}
      {active && <span aria-hidden>{sort.dir === "asc" ? "↑" : "↓"}</span>}
    </button>
  );
}

function ariaSort(sort: SortState, key: string): "ascending" | "descending" | "none" {
  return sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
}

/** A count cell's text: "—" for an unknowable window, the number otherwise;
 *  zeros muted, other numbers semibold (the mockup). */
function Count({ v }: { v: number | null }) {
  if (v === null) return <span className="text-muted-foreground">—</span>;
  return <span className={v === 0 ? "text-muted-foreground" : "font-semibold"}>{v.toLocaleString()}</span>;
}

function LearnersView({
  rows,
  publications,
  allMode,
  highImpactThreshold,
  tail,
  query,
}: {
  rows: MentoredPubsSummaryRow[];
  publications: MentoredPubsPublicationRow[];
  allMode: boolean;
  highImpactThreshold: number;
  tail: number;
  query: string;
}) {
  const [sort, setSort] = React.useState<SortState>({ key: "grad", dir: "desc" });
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const onSort = (key: string) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: LEARNER_COLS[key].dir },
    );
  const q = query.trim().toLowerCase();
  const found = React.useMemo(
    () =>
      q
        ? rows.filter((r) =>
            [learnerName(r), r.cwid, ...r.mentors.flatMap((m) => [m.name, m.cwid])].some((s) =>
              s.toLowerCase().includes(q),
            ),
          )
        : rows,
    [rows, q],
  );
  const sorted = React.useMemo(() => sortRows(found, LEARNER_COLS[sort.key], sort.dir), [found, sort]);
  const { visible, hasMore, showMore, rangeLabel } = useShowMore(sorted);
  const pubsOf = React.useMemo(() => {
    const m = new Map<string, MentoredPubsPublicationRow[]>();
    for (const p of publications) for (const l of p.learners) m.set(l.cwid, [...(m.get(l.cwid) ?? []), p]);
    return m;
  }, [publications]);

  if (rows.length === 0 || found.length === 0) {
    return (
      <p className="text-muted-foreground py-7 text-sm" data-testid="mentored-pubs-empty">
        {rows.length === 0 ? "No learners match these filters." : `No learners or mentors match “${query.trim()}”.`}
      </p>
    );
  }
  const C = LEARNER_COLS;
  const windowRule = `Entry year ≤ publication year ≤ graduation year + ${tail}`;
  const numCols: Array<{ col: SortCol<MentoredPubsSummaryRow>; label: string; title: string; get: (r: MentoredPubsSummaryRow) => number | null }> = [
    { col: C.win, label: "In window", title: windowRule, get: (r) => r.pubsInWindow },
    ...(allMode
      ? [{ col: C.withMentor, label: "With a mentor", title: "In window, with a mentor on the byline", get: (r: MentoredPubsSummaryRow) => r.withMentorInWindow }]
      : []),
    { col: C.all, label: "All years", title: "Every year, in window or not", get: (r) => r.pubsAllTime },
    {
      col: C.if10,
      label: `JIF ≥ ${highImpactThreshold}`,
      title: `In window, in a journal with Journal Impact Factor ≥ ${highImpactThreshold}`,
      get: (r) => r.highImpactInWindow,
    },
    { col: C.first, label: "First author", title: "In window, learner is first author", get: (r) => r.firstAuthorInWindow },
  ];
  const colSpan = 2 + numCols.length;

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm" data-testid="mentored-pubs-summary">
          <thead className="bg-apollo-surface-2">
            <tr>
              <th className={TH} aria-sort={sort.key === "learner" || sort.key === "grad" ? ariaSort(sort, sort.key) : "none"}>
                <span className="inline-flex flex-wrap items-end gap-x-2">
                  <SortButton col={C.learner} sort={sort} onSort={onSort}>
                    Learner
                  </SortButton>
                  <span aria-hidden>·</span>
                  <SortButton col={C.grad} sort={sort} onSort={onSort} title="Sort by graduation year">
                    Grad year
                  </SortButton>
                </span>
              </th>
              <th className={`${TH} hidden md:table-cell`}>Mentors</th>
              {numCols.map((c) => (
                <th key={c.col.key} className={`${TH} hidden w-16 text-right md:table-cell`} aria-sort={ariaSort(sort, c.col.key)}>
                  <SortButton col={c.col} sort={sort} onSort={onSort} title={c.title}>
                    {c.label}
                  </SortButton>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const has = r.pubsAllTime > 0;
              const open = has && expanded === r.cwid;
              const toggle = () => has && setExpanded((cur) => (cur === r.cwid ? null : r.cwid));
              const mine = open
                ? [...(pubsOf.get(r.cwid) ?? [])].sort(
                    (a, b) => compareNullsLast(a.year, b.year, "desc") || compareNullsLast(a.dateAdded?.getTime() ?? null, b.dateAdded?.getTime() ?? null, "desc"),
                  )
                : [];
              return (
                <React.Fragment key={r.cwid}>
                  <tr
                    className={`border-apollo-border hover:bg-apollo-page border-t ${has ? "cursor-pointer" : ""} ${open ? "bg-apollo-page" : ""}`}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("a, button")) return;
                      toggle();
                    }}
                    data-testid={`mentored-pubs-learner-${r.cwid}`}
                  >
                    <td className={TD}>
                      <div className="flex items-start gap-1.5">
                        {has ? (
                          <button
                            type="button"
                            onClick={toggle}
                            aria-expanded={open}
                            aria-label={`${open ? "Hide" : "Show"} publications of ${learnerName(r)}`}
                            className="text-muted-foreground hover:text-foreground mt-0.5 -ml-1 shrink-0"
                          >
                            {open ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
                          </button>
                        ) : (
                          <span className="w-3 shrink-0" aria-hidden />
                        )}
                        <div className="min-w-0">
                          <ScholarHoverCard cwid={r.cwid}>
                            <span className="font-semibold leading-snug hover:underline">{learnerName(r) || r.cwid}</span>
                          </ScholarHoverCard>
                          <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-1.5 text-[13px]">
                            <span className="font-mono text-xs leading-5">{r.cwid}</span>
                            <span>{r.gradYear !== null ? `Grad ${r.gradYear}` : "No grad year"}</span>
                            {r.entryYearSource === "fallback" && (
                              <span title="Entry year not on the pairing sheet; the window assumes a 4-year track.">
                                (entry est. {r.entryYear})
                              </span>
                            )}
                          </div>
                          {/* Below md: the mentors and the numbers stack here. */}
                          <div className="mt-2.5 md:hidden" data-testid="mentored-pubs-stacked">
                            <MentorList mentors={r.mentors} />
                            <dl className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(5.5rem,1fr))] gap-x-3 gap-y-1 text-[13px]">
                              {numCols.map((c) => (
                                <div key={c.col.key} className="flex items-baseline justify-between gap-1.5">
                                  <dt className="text-muted-foreground">{c.label}</dt>
                                  <dd className="m-0 tabular-nums">
                                    <Count v={c.get(r)} />
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className={`${TD} hidden md:table-cell`}>
                      <MentorList mentors={r.mentors} />
                    </td>
                    {numCols.map((c) => (
                      <td key={c.col.key} className={NUM_TD}>
                        <Count v={c.get(r)} />
                      </td>
                    ))}
                  </tr>
                  {open && (
                    <tr className="bg-apollo-page border-apollo-border border-t" data-testid={`mentored-pubs-expanded-${r.cwid}`}>
                      <td colSpan={colSpan} className="px-4 pb-1 md:pl-10">
                        <ol className="m-0 list-none p-0">
                          {mine.map((p) => (
                            <PubItem key={p.pmid} p={p} allMode={allMode} focus={r.cwid} />
                          ))}
                        </ol>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <ShowMoreRow
        label={`${rangeLabel} ${found.length === 1 ? "learner" : "learners"} · select a row to see its publications`}
        hasMore={hasMore}
        onMore={showMore}
        testId="mentored-pubs-learners"
      />
    </>
  );
}

// ---- Publications ----------------------------------------------------------------

export const PUB_SORTS = {
  date: { label: "Recently added to PubMed", col: { key: "date", get: (r) => r.dateAdded?.getTime() ?? null, dir: "desc" } },
  year: { label: "Newest first", col: { key: "year", get: (r) => r.year, dir: "desc" } },
  jif: { label: "Journal Impact Factor", col: { key: "jif", get: (r) => r.jif, dir: "desc" } },
  citations: { label: "Most cited", col: { key: "citations", get: (r) => r.citations, dir: "desc" } },
  title: { label: "Title A–Z", col: { key: "title", get: (r) => r.title, dir: "asc" } },
} satisfies Record<string, { label: string; col: SortCol<MentoredPubsPublicationRow> }>;
type PubSort = keyof typeof PUB_SORTS;

function PublicationsView({
  rows,
  allMode,
  sort,
}: {
  rows: MentoredPubsPublicationRow[];
  allMode: boolean;
  sort: PubSort;
}) {
  const sorted = React.useMemo(() => {
    const { col } = PUB_SORTS[sort];
    return sortRows(rows, col, col.dir);
  }, [rows, sort]);
  const { visible, hasMore, showMore, rangeLabel } = useShowMore(sorted);
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground py-7 text-sm" data-testid="mentored-pubs-empty">
        No publications match these filters.
      </p>
    );
  }
  return (
    <>
      <ol className="m-0 list-none p-0" data-testid="mentored-pubs-publications">
        {visible.map((p) => (
          <PubItem key={p.pmid} p={p} allMode={allMode} />
        ))}
      </ol>
      <ShowMoreRow
        label={`${rangeLabel} ${rows.length === 1 ? "publication" : "publications"}`}
        hasMore={hasMore}
        onMore={showMore}
        testId="mentored-pubs-publications"
      />
    </>
  );
}

// ---- the island ---------------------------------------------------------------------

export function MentoredPublicationsTable({
  view: initialView,
  viewHrefs,
  summary,
  publications,
  pubsMode,
  highImpactThreshold,
  tail,
  initialQuery = "",
  formIds,
}: {
  view: View;
  /** The page URL for each view with every other param kept — the tab's
   *  href (no-JS fallback) and what a click writes into the address bar. */
  viewHrefs: Record<View, string>;
  summary: MentoredPubsSummaryRow[];
  publications: MentoredPubsPublicationRow[];
  pubsMode: "mentored" | "all";
  /** `HIGH_IMPACT_THRESHOLD` — its module reads `@/lib/db`, so it is a prop. */
  highImpactThreshold: number;
  /** The counting window's years past graduation (the In window hover). */
  tail: number;
  /** `q` from the URL: the find box's starting text. */
  initialQuery?: string;
  /** The rail forms' ids (desktop + phone sheet) the hidden `view` / `q`
   *  inputs bind to. */
  formIds: ReadonlyArray<string>;
}) {
  const [view, setView] = React.useState<View>(initialView);
  const [query, setQuery] = React.useState(initialQuery);
  const [pubSort, setPubSort] = React.useState<PubSort>("date");
  const allMode = pubsMode === "all";

  // The server's hrefs never carry `q` (the body strips it), so appending is enough.
  const withQuery = (href: string, q: string) =>
    q.trim() ? `${href}${href.includes("?") ? "&" : "?"}q=${encodeURIComponent(q.trim())}` : href;
  const pick = (next: View) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new tab / window: let the link be
    e.preventDefault();
    setView(next);
    window.history.replaceState(null, "", withQuery(viewHrefs[next], query));
  };
  const onQuery = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    window.history.replaceState(null, "", withQuery(viewHrefs[view], e.target.value));
  };
  const tab = (v: View, label: string) => (
    <a
      href={withQuery(viewHrefs[v], query)}
      onClick={pick(v)}
      className={view === v ? TAB_ACTIVE : TAB_IDLE}
      aria-current={view === v ? "page" : undefined}
      data-testid={`mentored-pubs-view-${v}`}
    >
      {label}
    </a>
  );

  return (
    <>
      {formIds.map((id) => (
        <React.Fragment key={id}>
          <input type="hidden" name="view" value={view} form={id} />
          {query.trim() && <input type="hidden" name="q" value={query.trim()} form={id} />}
        </React.Fragment>
      ))}
      <div className="border-apollo-border mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b">
        <nav className="flex gap-6" aria-label="Report views">
          {tab("summary", `Learners (${summary.length.toLocaleString()})`)}
          {tab("publications", `Publications (${publications.length.toLocaleString()})`)}
        </nav>
        {view === "summary" ? (
          <input
            type="search"
            value={query}
            onChange={onQuery}
            placeholder="Find a learner or mentor"
            aria-label="Find a learner or mentor"
            className="border-apollo-border-strong bg-apollo-surface mb-2 h-8 w-full rounded-md border px-2.5 text-sm sm:w-56"
            data-testid="mentored-pubs-find"
          />
        ) : (
          <label className="mb-2 flex items-center gap-2 text-[13px]">
            <span className="text-muted-foreground">Sort</span>
            <select
              value={pubSort}
              onChange={(e) => setPubSort(e.target.value as PubSort)}
              className="border-apollo-border-strong bg-apollo-surface h-8 rounded-md border px-2 text-[13px]"
              data-testid="mentored-pubs-sort"
            >
              {(Object.keys(PUB_SORTS) as PubSort[]).map((k) => (
                <option key={k} value={k}>
                  {PUB_SORTS[k].label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {view === "publications" ? (
        <PublicationsView rows={publications} allMode={allMode} sort={pubSort} />
      ) : (
        <LearnersView
          rows={summary}
          publications={publications}
          allMode={allMode}
          highImpactThreshold={highImpactThreshold}
          tail={tail}
          query={query}
        />
      )}
    </>
  );
}
