"use client";

import * as React from "react";

import { RosterFacet, type FacetOption } from "@/components/center/center-roster-facets";
import { citationIdentifier } from "@/lib/citation";
import type {
  MentoredPubsLearnerOnPub,
  MentoredPubsPublicationRow,
  MentoredPubsSummaryRow,
  MentorRef,
} from "@/lib/edit/mentored-publications-report";
import {
  mentorshipDefaultSelected,
  mentorshipKey,
  mentorshipLabel,
  type MentorshipType,
} from "@/lib/edit/mentorship-type";

/**
 * `/edit/reports/7` — the Learners / Publications tables as a client island:
 * a facet rail on the left, a sortable table on the right, the shape
 * `publications-report-table.tsx` (report 3) proves out. Every row arrives
 * loaded from the page; filtering and sorting are `useMemo` over them (no
 * fetch, no URL state); the rail is `RosterFacet`, each facet counting the
 * rows that pass every OTHER facet (the cross-facet convention it documents).
 * A facet with no selection passes every row. The .xlsx download is
 * server-filtered only (program / years / set / tail) — never by the rail.
 *
 * "Type of mentorship" (`lib/edit/mentorship-type.ts`) is the one facet that
 * starts with a selection: roster / Jenzabar / ED pairs checked, co-author
 * inferences unchecked; clearing it passes every row like any other facet,
 * so it is never a dead end. Sortable headers are a `<button>` in the `<th>`
 * (`aria-sort` on the active one); clicking the active header flips the
 * direction; nulls sort last either way. Rows render capped at `ROW_CAP`
 * behind "Show all N".
 *
 * The Learners | Publications tabs live here too: both views ride on the same
 * loaded report, so a tab click swaps the view in state and only rewrites the
 * URL (`history.replaceState`, which Next's router picks up) — no server
 * round trip, nothing to wait for. The current view is carried to the filter
 * form by a hidden input bound with `form="mentored-pubs-filters"`, so a
 * filter change submits the view the user is looking at; without JS the tab
 * is a plain link and the server renders `?view=`.
 */

const TH_CLASS = "text-muted-foreground px-3 py-2 text-xs font-semibold tracking-wide whitespace-nowrap uppercase";
const TD_CLASS = "border-apollo-border border-t px-3 py-2 align-top";
const NUM_CLASS = `${TD_CLASS} text-right tabular-nums`;
const CWID_CLASS = "text-muted-foreground ml-2 font-mono text-xs";
const CHIP_CLASS = "text-muted-foreground ml-2 text-xs";
const ROW_CAP = 200;

// ---- facets ---------------------------------------------------------------

type Facet<Row> = {
  id: string;
  title: string;
  /** The values a row carries for this facet (a row may carry several). */
  values: (row: Row) => string[];
  label?: (value: string) => string;
  /** Option order; default count desc, then label. */
  compare?: (a: FacetOption, b: FacetOption) => number;
  /** A row with NO value passes any selection — "all" mode's solo pubs have
   *  no mentor and so no type, and must not vanish behind the default rail. */
  emptyPasses?: boolean;
  collapseAfter?: number;
  searchable?: boolean;
};
type Selection = Record<string, ReadonlySet<string>>;
const NONE: ReadonlySet<string> = new Set();

function passes<Row>(row: Row, f: Facet<Row>, sel: ReadonlySet<string>): boolean {
  if (sel.size === 0) return true;
  const values = f.values(row);
  if (values.length === 0) return !!f.emptyPasses;
  return values.some((v) => sel.has(v));
}

/** Every value of `facet` across ALL rows (so the option list is stable),
 *  counted over the rows that pass every OTHER facet. */
function facetOptions<Row>(
  rows: readonly Row[],
  facets: Facet<Row>[],
  sel: Selection,
  facet: Facet<Row>,
): FacetOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const counted = facets.every((f) => f === facet || passes(row, f, sel[f.id] ?? NONE));
    for (const v of new Set(facet.values(row))) counts.set(v, (counts.get(v) ?? 0) + (counted ? 1 : 0));
  }
  return [...counts]
    .map(([value, count]) => ({ value, label: facet.label?.(value) ?? value, count }))
    .sort(facet.compare ?? ((a, b) => b.count - a.count || a.label.localeCompare(b.label)));
}

function useFacetRail<Row>(rows: readonly Row[], facets: Facet<Row>[], initial: Selection) {
  const [selected, setSelected] = React.useState<Selection>(initial);
  const toggle = (id: string) => (value: string) =>
    setSelected((prev) => {
      const next = new Set(prev[id] ?? NONE);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, [id]: next };
    });
  const filtered = React.useMemo(
    () => rows.filter((r) => facets.every((f) => passes(r, f, selected[f.id] ?? NONE))),
    [rows, facets, selected],
  );
  const rail = facets.map((f) => (
    <RosterFacet
      key={f.id}
      title={f.title}
      options={facetOptions(rows, facets, selected, f)}
      selected={selected[f.id] ?? NONE}
      onToggle={toggle(f.id)}
      collapseAfter={f.collapseAfter}
      searchable={f.searchable}
    />
  ));
  return { filtered, rail };
}

/** "Type of mentorship": sourced pairs first, then co-author, each group by
 *  count desc; the initial selection is every sourced type. */
function typeFacet<Row>(
  rows: readonly Row[],
  types: (row: Row) => MentorshipType[],
): { facet: Facet<Row>; initial: ReadonlySet<string> } {
  const byKey = new Map<string, MentorshipType>();
  for (const r of rows) for (const t of types(r)) byKey.set(mentorshipKey(t), t);
  const coauthor = (o: FacetOption) => (byKey.get(o.value)?.source === "coauthor" ? 1 : 0);
  return {
    facet: {
      id: "type",
      title: "Type of mentorship",
      values: (r) => types(r).map(mentorshipKey),
      label: (k) => {
        const t = byKey.get(k);
        return t ? mentorshipLabel(t) : k;
      },
      compare: (a, b) => coauthor(a) - coauthor(b) || b.count - a.count || a.label.localeCompare(b.label),
      emptyPasses: true,
    },
    initial: new Set([...byKey].filter(([, t]) => mentorshipDefaultSelected(t)).map(([k]) => k)),
  };
}

const fixedOrder = (order: readonly string[]) => (a: FacetOption, b: FacetOption) =>
  order.indexOf(a.value) - order.indexOf(b.value);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- sorting --------------------------------------------------------------

type SortDir = "asc" | "desc";
type SortState = { key: string; dir: SortDir };
/** `dir` is the direction a first click on the header sorts by. */
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

function useSort<Row>(rows: readonly Row[], cols: Record<string, SortCol<Row>>, initialKey: string) {
  const [sort, setSort] = React.useState<SortState>({ key: initialKey, dir: cols[initialKey].dir });
  const onSort = (key: string) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: cols[key].dir },
    );
  const sorted = React.useMemo(() => {
    const col = cols[sort.key];
    // Stable, so the loader's own order breaks ties.
    return [...rows].sort((a, b) => compareNullsLast(col.get(a), col.get(b), sort.dir));
  }, [rows, cols, sort]);
  return { sorted, sort, onSort };
}

function SortHeader<Row>({
  col,
  sort,
  onSort,
  className = "",
  children,
}: {
  col: SortCol<Row>;
  sort: SortState;
  onSort: (key: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const active = sort.key === col.key;
  return (
    <th
      className={`${TH_CLASS} ${className}`}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" onClick={() => onSort(col.key)} className="cursor-pointer hover:underline">
        {children}
        {active ? <span aria-hidden="true">{sort.dir === "asc" ? " ^" : " v"}</span> : null}
      </button>
    </th>
  );
}

// ---- shared pieces --------------------------------------------------------

function useRowCap<Row>(rows: readonly Row[]) {
  const [showAll, setShowAll] = React.useState(false);
  const shown = showAll ? rows : rows.slice(0, ROW_CAP);
  const button =
    shown.length < rows.length ? (
      <button
        type="button"
        onClick={() => setShowAll(true)}
        className="border-apollo-border hover:bg-apollo-surface-2 self-start rounded border px-3 py-1.5 text-sm"
        data-testid="mentored-pubs-show-all"
      >
        Show all {rows.length.toLocaleString()}
      </button>
    ) : null;
  return { shown, button };
}

/** Rail left, table right (stacked on narrow), the "Showing X of Y" line
 *  above the table. */
function Layout({
  rail,
  shown,
  total,
  noun,
  children,
}: {
  rail: React.ReactNode;
  shown: number;
  total: number;
  noun: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4 grid grid-cols-1 items-start gap-5 md:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="border-apollo-rail-border bg-apollo-rail w-full shrink-0 rounded-xl border p-3 md:w-64">{rail}</div>
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-muted-foreground text-sm" data-testid="mentored-pubs-shown">
          Showing {shown.toLocaleString()} of {total.toLocaleString()} {noun}
        </p>
        {children}
      </div>
    </div>
  );
}

function Empty({ noun }: { noun: string }) {
  return (
    <p className="text-muted-foreground mt-6" data-testid="mentored-pubs-empty">
      No {noun} match these filters.
    </p>
  );
}

const learnerName = (l: { firstName: string | null; lastName: string | null }) =>
  [l.lastName, l.firstName].filter(Boolean).join(", ");

/** "Name  cwid", the type label(s) beneath when the mentor carries them. */
function MentorCell({ mentors }: { mentors: ReadonlyArray<MentorRef & { mentorships?: MentorshipType[] }> }) {
  if (mentors.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="m-0 list-none p-0">
      {mentors.map((m) => (
        <li key={m.cwid}>
          {m.name}
          <span className={CWID_CLASS}>{m.cwid}</span>
          {m.mentorships?.map((t) => (
            <div key={mentorshipKey(t)} className="text-muted-foreground text-xs">
              {mentorshipLabel(t)}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

// ---- Publications view ----------------------------------------------------

const POSITIONS = ["first", "last", "middle"] as const;
type Position = (typeof POSITIONS)[number];

function learnerPosition(l: MentoredPubsLearnerOnPub, authorCount: number): Position | null {
  if (l.authorPosition === null) return null;
  if (l.authorPosition === 1) return "first";
  if (l.authorPosition === authorCount) return "last";
  return "middle";
}

const windowValue = (inWindow: boolean | null) => (inWindow === null ? "unknown" : inWindow ? "yes" : "no");

const PUB_COLS: Record<string, SortCol<MentoredPubsPublicationRow>> = {
  title: { key: "title", get: (r) => r.title, dir: "asc" },
  date: { key: "date", get: (r) => r.dateAdded?.getTime() ?? null, dir: "desc" },
  year: { key: "year", get: (r) => r.year, dir: "desc" },
  jif: { key: "jif", get: (r) => r.jif, dir: "desc" },
  citations: { key: "citations", get: (r) => r.citations, dir: "desc" },
};

function PublicationsView({ rows, allMode }: { rows: MentoredPubsPublicationRow[]; allMode: boolean }) {
  const { facets, initial } = React.useMemo(() => {
    const type = typeFacet(rows, (r) => r.mentors.flatMap((m) => m.mentorships));
    const facets: Facet<MentoredPubsPublicationRow>[] = [
      type.facet,
      {
        id: "year",
        title: "Year",
        values: (r) => (r.year === null ? [] : [String(r.year)]),
        compare: (a, b) => Number(b.value) - Number(a.value),
        collapseAfter: 6,
      },
      {
        id: "position",
        title: "Learner author position",
        values: (r) =>
          r.learners.map((l) => learnerPosition(l, r.authorCount)).filter((p): p is Position => p !== null),
        label: capitalize,
        compare: fixedOrder(POSITIONS),
      },
      {
        id: "window",
        title: "In program window",
        values: (r) => r.learners.map((l) => windowValue(l.inWindow)),
        label: capitalize,
        compare: fixedOrder(["yes", "no", "unknown"]),
      },
      { id: "mentor", title: "Mentor", values: (r) => r.mentors.map((m) => m.name), collapseAfter: 8, searchable: true },
    ];
    return { facets, initial: { type: type.initial } };
  }, [rows]);
  const { filtered, rail } = useFacetRail(rows, facets, initial);
  const { sorted, sort, onSort } = useSort(filtered, PUB_COLS, "date");
  const { shown, button } = useRowCap(sorted);
  const th = { sort, onSort };

  if (rows.length === 0) return <Empty noun="publications" />;
  return (
    <Layout rail={rail} shown={filtered.length} total={rows.length} noun="publications">
      {filtered.length === 0 ? (
        <Empty noun="publications" />
      ) : (
        <div className="border-apollo-border bg-apollo-surface overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-left text-sm" data-testid="mentored-pubs-publications">
            <thead>
              <tr>
                <SortHeader col={PUB_COLS.title} {...th}>
                  Citation
                </SortHeader>
                <SortHeader col={PUB_COLS.date} {...th}>
                  Date added
                </SortHeader>
                <SortHeader col={PUB_COLS.year} {...th}>
                  Year
                </SortHeader>
                <SortHeader col={PUB_COLS.jif} {...th} className="text-right">
                  JIF
                </SortHeader>
                <SortHeader col={PUB_COLS.citations} {...th} className="text-right">
                  Citations
                </SortHeader>
                <th className={TH_CLASS}>Learner(s)</th>
                <th className={TH_CLASS}>Mentor(s)</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const id = citationIdentifier(p.pmid);
                return (
                  <tr key={p.pmid} data-testid={`mentored-pubs-pub-${p.pmid}`}>
                    <td className={TD_CLASS}>
                      {p.citation}{" "}
                      <span className="whitespace-nowrap">
                        {id.label}:{" "}
                        {id.href ? (
                          <a
                            href={id.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-apollo-slate hover:underline"
                          >
                            {id.value}
                          </a>
                        ) : (
                          id.value
                        )}
                      </span>
                    </td>
                    <td className={`${TD_CLASS} whitespace-nowrap tabular-nums`}>
                      {p.dateAdded ? p.dateAdded.toISOString().slice(0, 10) : "—"}
                    </td>
                    <td className={`${TD_CLASS} tabular-nums`}>{p.year ?? "—"}</td>
                    <td className={NUM_CLASS}>{p.jif ?? "—"}</td>
                    <td className={NUM_CLASS}>{p.citations ?? "—"}</td>
                    <td className={TD_CLASS}>
                      <ul className="m-0 list-none p-0">
                        {p.learners.map((l) => {
                          const pos = learnerPosition(l, p.authorCount);
                          return (
                            <li key={l.cwid} className="whitespace-nowrap">
                              {learnerName(l)}
                              <span className={CWID_CLASS}>{l.cwid}</span>
                              {pos === "first" && (
                                <span className={CHIP_CLASS} title="Learner is first author">
                                  1st author
                                </span>
                              )}
                              {pos === "last" && (
                                <span className={CHIP_CLASS} title="Learner is last author">
                                  last author
                                </span>
                              )}
                              <span
                                className={CHIP_CLASS}
                                title={
                                  l.inWindow === null
                                    ? "Program window unknown (no graduation or entry year on the roster)"
                                    : "Publication year inside this learner's program window"
                                }
                              >
                                In window: {l.inWindow === null ? "—" : l.inWindow ? "Yes" : "No"}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </td>
                    <td className={TD_CLASS}>
                      {allMode && !p.withMentor ? (
                        <span className="text-muted-foreground">No mentor co-author</span>
                      ) : (
                        <MentorCell mentors={p.mentors} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {button}
    </Layout>
  );
}

// ---- Learners view --------------------------------------------------------

const num = (key: string, get: (r: MentoredPubsSummaryRow) => number | null): SortCol<MentoredPubsSummaryRow> => ({
  key,
  get,
  dir: "desc",
});
const LEARNER_COLS: Record<string, SortCol<MentoredPubsSummaryRow>> = {
  gradYear: num("gradYear", (r) => r.gradYear),
  learner: { key: "learner", get: (r) => learnerName(r) || null, dir: "asc" },
  pubsInWindow: num("pubsInWindow", (r) => r.pubsInWindow),
  withMentorInWindow: num("withMentorInWindow", (r) => r.withMentorInWindow),
  pubsAllTime: num("pubsAllTime", (r) => r.pubsAllTime),
  highImpactInWindow: num("highImpactInWindow", (r) => r.highImpactInWindow),
  firstAuthorInWindow: num("firstAuthorInWindow", (r) => r.firstAuthorInWindow),
};

function LearnersView({
  rows,
  allMode,
  highImpactThreshold,
}: {
  rows: MentoredPubsSummaryRow[];
  allMode: boolean;
  highImpactThreshold: number;
}) {
  const { facets, initial } = React.useMemo(() => {
    const type = typeFacet(rows, (r) => r.mentors.map((m) => m.mentorship));
    const facets: Facet<MentoredPubsSummaryRow>[] = [
      type.facet,
      {
        id: "window",
        title: "In program window",
        values: (r) => [r.pubsInWindow === null ? "unknown" : "known"],
        label: capitalize,
        compare: fixedOrder(["known", "unknown"]),
      },
      { id: "mentor", title: "Mentor", values: (r) => r.mentors.map((m) => m.name), collapseAfter: 8, searchable: true },
    ];
    return { facets, initial: { type: type.initial } };
  }, [rows]);
  const { filtered, rail } = useFacetRail(rows, facets, initial);
  const { sorted, sort, onSort } = useSort(filtered, LEARNER_COLS, "gradYear");
  const { shown, button } = useRowCap(sorted);
  const th = { sort, onSort, className: "text-right" };
  const C = LEARNER_COLS;

  if (rows.length === 0) return <Empty noun="learners" />;
  return (
    <Layout rail={rail} shown={filtered.length} total={rows.length} noun="learners">
      {filtered.length === 0 ? (
        <Empty noun="learners" />
      ) : (
        <div className="border-apollo-border bg-apollo-surface overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-left text-sm" data-testid="mentored-pubs-summary">
            <thead>
              <tr>
                <SortHeader col={C.gradYear} sort={sort} onSort={onSort}>
                  Grad year
                </SortHeader>
                <SortHeader col={C.learner} sort={sort} onSort={onSort}>
                  Learner
                </SortHeader>
                <th className={TH_CLASS}>Program</th>
                <th className={TH_CLASS}>Type of mentorship</th>
                <th className={TH_CLASS}>Mentors</th>
                {allMode ? (
                  <>
                    <SortHeader col={C.pubsInWindow} {...th}>
                      All pubs (in window)
                    </SortHeader>
                    <SortHeader col={C.withMentorInWindow} {...th}>
                      With a mentor (in window)
                    </SortHeader>
                    <SortHeader col={C.firstAuthorInWindow} {...th}>
                      First author (in window)
                    </SortHeader>
                    <SortHeader col={C.highImpactInWindow} {...th}>
                      JIF &ge; {highImpactThreshold} (in window)
                    </SortHeader>
                    <SortHeader col={C.pubsAllTime} {...th}>
                      All-time total
                    </SortHeader>
                  </>
                ) : (
                  <>
                    <SortHeader col={C.pubsInWindow} {...th}>
                      In window
                    </SortHeader>
                    <SortHeader col={C.pubsAllTime} {...th}>
                      All years
                    </SortHeader>
                    <SortHeader col={C.highImpactInWindow} {...th}>
                      JIF &ge; {highImpactThreshold}
                    </SortHeader>
                    <SortHeader col={C.firstAuthorInWindow} {...th}>
                      First author
                    </SortHeader>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.cwid} data-testid={`mentored-pubs-learner-${r.cwid}`}>
                  <td className={TD_CLASS}>{r.gradYear ?? "—"}</td>
                  <td className={TD_CLASS}>
                    {learnerName(r)}
                    <span className={CWID_CLASS}>{r.cwid}</span>
                    {r.entryYearSource === "fallback" && (
                      <span className={CHIP_CLASS} title="Entry year not on the roster; window assumes a 4-year track.">
                        (entry est. {r.entryYear})
                      </span>
                    )}
                  </td>
                  <td className={TD_CLASS}>{r.program}</td>
                  {/* One line per mentor, in the Mentors column's order. */}
                  <td className={TD_CLASS}>
                    <ul className="m-0 list-none p-0">
                      {r.mentors.map((m) => (
                        <li key={m.cwid} className="whitespace-nowrap">
                          {mentorshipLabel(m.mentorship)}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className={TD_CLASS}>
                    <MentorCell mentors={r.mentors} />
                  </td>
                  {/* "—" = no window to count against (no grad or entry year). */}
                  {allMode ? (
                    <>
                      <td className={NUM_CLASS}>{r.pubsInWindow ?? "—"}</td>
                      <td className={NUM_CLASS}>{r.withMentorInWindow ?? "—"}</td>
                      <td className={NUM_CLASS}>{r.firstAuthorInWindow ?? "—"}</td>
                      <td className={NUM_CLASS}>{r.highImpactInWindow ?? "—"}</td>
                      <td className={NUM_CLASS}>{r.pubsAllTime}</td>
                    </>
                  ) : (
                    <>
                      <td className={NUM_CLASS}>{r.pubsInWindow ?? "—"}</td>
                      <td className={NUM_CLASS}>{r.pubsAllTime}</td>
                      <td className={NUM_CLASS}>{r.highImpactInWindow ?? "—"}</td>
                      <td className={NUM_CLASS}>{r.firstAuthorInWindow ?? "—"}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {button}
    </Layout>
  );
}

type View = "summary" | "publications";

const TAB_ACTIVE = "border-apollo-maroon inline-block border-b-2 py-2.5 text-base font-medium";
const TAB_IDLE =
  "text-muted-foreground hover:text-foreground inline-block border-b-2 border-transparent py-2.5 text-base";

export function MentoredPublicationsTable({
  view: initialView,
  viewHrefs,
  downloadHref,
  summary,
  publications,
  pubsMode,
  highImpactThreshold,
}: {
  view: View;
  /** The page URL for each view with every other param kept — the tab's
   *  href (no-JS fallback) and what a click writes into the address bar. */
  viewHrefs: Record<View, string>;
  downloadHref: string;
  summary: MentoredPubsSummaryRow[];
  publications: MentoredPubsPublicationRow[];
  pubsMode: "mentored" | "all";
  /** `HIGH_IMPACT_THRESHOLD` — its module reads `@/lib/db`, so it is a prop. */
  highImpactThreshold: number;
}) {
  const [view, setView] = React.useState<View>(initialView);
  const allMode = pubsMode === "all";
  const pick = (next: View) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new tab / window: let the link be
    e.preventDefault();
    setView(next);
    window.history.replaceState(null, "", viewHrefs[next]);
  };
  const tab = (v: View, label: string) => (
    <a
      href={viewHrefs[v]}
      onClick={pick(v)}
      className={view === v ? TAB_ACTIVE : TAB_IDLE}
      aria-current={view === v ? "page" : undefined}
      data-testid={`mentored-pubs-view-${v}`}
    >
      {label}
    </a>
  );
  const totalInWindow = summary.reduce((n, r) => n + (r.pubsInWindow ?? 0), 0);
  const totalAllTime = summary.reduce((n, r) => n + r.pubsAllTime, 0);
  return (
    <>
      <input type="hidden" name="view" value={view} form="mentored-pubs-filters" />
      <nav className="border-apollo-border mt-4 flex gap-4 border-b" aria-label="View">
        {tab("summary", "Learners")}
        {tab("publications", "Publications")}
      </nav>
      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
        <p data-testid="mentored-pubs-total">
          <strong>{summary.length.toLocaleString()}</strong>{" "}
          {summary.length === 1 ? "learner" : "learners"} ·{" "}
          <strong>{totalInWindow.toLocaleString()}</strong> publications in window ·{" "}
          <strong>{totalAllTime.toLocaleString()}</strong> all years ·{" "}
          <strong>{publications.length.toLocaleString()}</strong> distinct{" "}
          {publications.length === 1 ? "publication" : "publications"}
        </p>
        <a
          href={downloadHref}
          className="bg-apollo-maroon text-apollo-maroon-foreground hover:bg-apollo-maroon/90 inline-flex h-8 items-center rounded-md px-3 text-sm font-medium"
          data-testid="mentored-pubs-download"
        >
          Download .xlsx
        </a>
      </div>
      {view === "publications" ? (
        <PublicationsView rows={publications} allMode={allMode} />
      ) : (
        <LearnersView rows={summary} allMode={allMode} highImpactThreshold={highImpactThreshold} />
      )}
    </>
  );
}
