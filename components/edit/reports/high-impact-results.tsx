"use client";

/**
 * Report 9's results: the Scholars / Publications tab row and the tab's
 * contents (reports redesign, `High-Impact Publications Redesign.dc.html`).
 *
 * The tabs stay links (`view=summary` / `view=publications`, the params every
 * earlier link carries); everything else here is view state that needs no
 * server trip: the "Find a scholar" box, the Scholars sort (Scholar /
 * Articles / Citations headers), a row's expansion to that scholar's
 * publications, the Publications sort, and "Show 25 more" (`useShowMore`).
 *
 * Mobile: the Scholars table keeps its five columns and scrolls inside its
 * own box (`overflow-x-auto`), never the page. Type-only imports from the
 * server lib; nothing here reaches `@/lib/db`.
 */
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";

import { useShowMore } from "@/components/edit/reports/report-show-more";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { Button } from "@/components/ui/button";
import type {
  AuthorRole,
  HighImpactRow,
  PersonSummaryRow,
} from "@/lib/edit/high-impact-pubs-report";
import { cn } from "@/lib/utils";

/** A publication as the page gets it (the download-only `authors` strings dropped). */
export type HighImpactPub = Omit<HighImpactRow, "authors">;

export type PubSort = "new" | "cites" | "journal" | "jif";

export const PUB_SORT_LABEL: Record<PubSort, string> = {
  new: "Newest first",
  cites: "Most cited",
  journal: "Journal A–Z",
  jif: "Highest impact factor",
};

type ScholarSort = "name" | "articles" | "cites";

const POSITION_TEXT: Record<AuthorRole, string> = {
  first: "First author",
  last: "Last author",
  middle: "Middle author",
};

const newest = (a: HighImpactPub, b: HighImpactPub) =>
  b.year - a.year ||
  (b.dateAdded ?? "").localeCompare(a.dateAdded ?? "") ||
  b.pmid.localeCompare(a.pmid);

/** Nulls last, whatever the direction. */
const desc = (a: number | null, b: number | null) => (b ?? -Infinity) - (a ?? -Infinity);

export function sortPubs(pubs: ReadonlyArray<HighImpactPub>, sort: PubSort): HighImpactPub[] {
  const cmp: Record<PubSort, (a: HighImpactPub, b: HighImpactPub) => number> = {
    new: newest,
    cites: (a, b) => desc(a.citations, b.citations) || newest(a, b),
    journal: (a, b) =>
      (a.journal === null ? 1 : 0) - (b.journal === null ? 1 : 0) ||
      (a.journal ?? "").localeCompare(b.journal ?? "") ||
      newest(a, b),
    jif: (a, b) => desc(a.jif, b.jif) || newest(a, b),
  };
  return [...pubs].sort(cmp[sort]);
}

const lastName = (name: string) => name.trim().split(/\s+/).pop() ?? name;

export function sortScholars(
  rows: ReadonlyArray<PersonSummaryRow>,
  key: ScholarSort,
  dir: 1 | -1,
): PersonSummaryRow[] {
  const val = {
    name: (r: PersonSummaryRow) => lastName(r.name),
    articles: (r: PersonSummaryRow) => r.articles,
    cites: (r: PersonSummaryRow) => r.citations,
  }[key];
  return [...rows].sort((x, y) => {
    const a = val(x);
    const b = val(y);
    const c = typeof a === "string" ? a.localeCompare(b as string) : a - (b as number);
    return c * dir || y.articles - x.articles || x.name.localeCompare(y.name);
  });
}

const TH =
  "text-muted-foreground px-3 py-2.5 text-xs font-semibold tracking-[0.08em] whitespace-nowrap uppercase";
const TD = "px-3 py-[11px] align-top";

export function HighImpactResults({
  view,
  tabHrefs,
  counts,
  people,
  pubs,
  showPersonType,
  overCapMessage,
}: {
  view: "summary" | "publications";
  tabHrefs: { summary: string; publications: string };
  counts: { scholars: number; articles: number };
  /** null = over the list cap (`overCapMessage` shows instead). */
  people: PersonSummaryRow[] | null;
  pubs: HighImpactPub[] | null;
  /** Several person types in scope → each row names its person type. */
  showPersonType: boolean;
  overCapMessage: string;
}) {
  const [query, setQuery] = useState("");
  const [pubSort, setPubSort] = useState<PubSort>("new");

  const tab = (v: typeof view, label: string) => (
    <Link
      href={tabHrefs[v]}
      aria-current={view === v ? "page" : undefined}
      data-testid={`high-impact-view-${v}`}
      className={cn(
        "-mb-px border-b-2 py-2.5 text-base whitespace-nowrap",
        view === v
          ? "border-apollo-maroon text-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground border-transparent",
      )}
    >
      {label}
    </Link>
  );

  return (
    <div data-testid="high-impact-results">
      <div className="border-apollo-border mt-6 flex flex-wrap items-end justify-between gap-x-4 border-b">
        <nav className="flex flex-wrap gap-x-7" aria-label="Report views">
          {tab("summary", `Scholars (${counts.scholars.toLocaleString()})`)}
          {tab("publications", `Publications (${counts.articles.toLocaleString()})`)}
        </nav>
        {people && pubs && (
          <div className="flex items-center gap-2 py-2">
            {view === "summary" ? (
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a scholar"
                aria-label="Find a scholar by name or CWID"
                className="border-apollo-border-strong bg-apollo-surface h-8 w-52 max-w-full rounded-md border px-2.5 text-sm"
              />
            ) : (
              <label className="text-muted-foreground flex items-center gap-2 text-[13px]">
                Sort
                <select
                  value={pubSort}
                  onChange={(e) => setPubSort(e.target.value as PubSort)}
                  className="border-apollo-border-strong bg-apollo-surface text-foreground h-8 rounded-md border px-2 text-[13px]"
                  data-testid="high-impact-pub-sort"
                >
                  {(Object.keys(PUB_SORT_LABEL) as PubSort[]).map((k) => (
                    <option key={k} value={k}>
                      {PUB_SORT_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </div>
      {!people || !pubs ? (
        <p className="text-muted-foreground py-7 text-sm">{overCapMessage}</p>
      ) : view === "summary" ? (
        <ScholarsTable people={people} pubs={pubs} query={query} showPersonType={showPersonType} />
      ) : (
        <PublicationsList pubs={pubs} sort={pubSort} />
      )}
    </div>
  );
}

function ScholarsTable({
  people,
  pubs,
  query,
  showPersonType,
}: {
  people: PersonSummaryRow[];
  pubs: HighImpactPub[];
  query: string;
  showPersonType: boolean;
}) {
  const [sort, setSort] = useState<{ key: ScholarSort; dir: 1 | -1 }>({ key: "articles", dir: -1 });
  const [expanded, setExpanded] = useState<string | null>(null);
  const byPmid = useMemo(() => new Map(pubs.map((p) => [p.pmid, p])), [pubs]);
  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      sortScholars(
        q ? people.filter((r) => `${r.name} ${r.cwid}`.toLowerCase().includes(q)) : people,
        sort.key,
        sort.dir,
      ),
    [people, q, sort],
  );
  const { visible, hasMore, showMore, rangeLabel } = useShowMore(rows);

  const header = (key: ScholarSort, label: string, align: "left" | "right", title?: string) => (
    <th
      className={cn(TH, align === "right" && "text-right")}
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        title={title}
        onClick={() =>
          setSort((s) => ({
            key,
            dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" ? 1 : -1,
          }))
        }
        className="hover:text-foreground inline-flex items-center gap-1 uppercase"
      >
        {label}
        <span aria-hidden>{sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : ""}</span>
      </button>
    </th>
  );

  return (
    <>
      <div className="overflow-x-auto">
        <table
          className="w-full min-w-[600px] border-collapse text-sm tabular-nums"
          data-testid="high-impact-summary"
        >
          <thead>
            <tr className="bg-apollo-surface-2 text-left">
              {header("name", "Scholar", "left")}
              {header("articles", "Articles", "right")}
              <th className={TH}>Position</th>
              {header("cites", "Citations", "right", "NIH iCite citation counts")}
              <th className={cn(TH, "w-[26%]")}>Journals</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const open = expanded === r.cwid;
              const toggle = () => setExpanded(open ? null : r.cwid);
              return [
                <tr
                  key={r.cwid}
                  onClick={toggle}
                  className={cn(
                    "border-apollo-border hover:bg-apollo-page cursor-pointer border-b",
                    open && "bg-apollo-page",
                  )}
                  data-testid="high-impact-scholar-row"
                >
                  <td className={cn(TD, "min-w-[200px]")}>
                    <ScholarHoverCard cwid={r.cwid}>
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle();
                        }}
                        className="hover:text-apollo-maroon text-left leading-[1.35] font-semibold"
                      >
                        {r.name}
                      </button>
                    </ScholarHoverCard>
                    <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-1.5 text-[13px]">
                      <span className="font-mono text-xs">{r.cwid}</span>
                      <span>
                        {[r.department, showPersonType ? r.personType : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  </td>
                  <td className={cn(TD, "text-right font-semibold")}>{r.articles}</td>
                  <td className={cn(TD, "text-[13px] whitespace-nowrap")}>
                    <span className="font-semibold">{r.firstAuthor}</span>{" "}
                    <span className="text-muted-foreground">first</span>
                    <span className="ml-2.5 font-semibold">{r.lastAuthor}</span>{" "}
                    <span className="text-muted-foreground">last</span>
                  </td>
                  <td className={cn(TD, "text-right")}>{r.citations.toLocaleString()}</td>
                  <td className={TD}>
                    <div className="flex flex-wrap items-center gap-1">
                      {r.journals.slice(0, 2).map((j) => (
                        <span
                          key={j}
                          className="bg-apollo-surface-2 border-apollo-border rounded border px-1.5 py-px text-xs whitespace-nowrap"
                        >
                          <PubJournal as="span" value={j} />
                        </span>
                      ))}
                      {r.journals.length > 2 && (
                        <span className="text-muted-foreground text-xs whitespace-nowrap">
                          +{r.journals.length - 2} more
                        </span>
                      )}
                    </div>
                  </td>
                </tr>,
                open && (
                  <tr
                    key={`${r.cwid}-pubs`}
                    className="bg-apollo-page border-apollo-border border-b"
                  >
                    <td colSpan={5} className="pt-0 pr-6 pb-1 pl-10">
                      <ol className="m-0 list-none p-0" data-testid="high-impact-scholar-pubs">
                        {r.pubs
                          .map((x) => ({ pub: byPmid.get(x.pmid), position: x.position }))
                          .filter((x): x is { pub: HighImpactPub; position: AuthorRole } => !!x.pub)
                          .sort((a, b) => newest(a.pub, b.pub))
                          .map(({ pub, position }) => (
                            <PubItem key={pub.pmid} pub={pub} who={POSITION_TEXT[position]} />
                          ))}
                      </ol>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p className="text-muted-foreground py-7 text-sm">
          {q
            ? `No scholars match “${query.trim()}”.`
            : "No scholars match. Try widening the years or author position."}
        </p>
      )}
      <Footer
        range={
          rows.length > 0 ? `${rangeLabel} scholars · select a row to see their publications` : ""
        }
        hasMore={hasMore}
        showMore={showMore}
      />
    </>
  );
}

function PublicationsList({ pubs, sort }: { pubs: HighImpactPub[]; sort: PubSort }) {
  const sorted = useMemo(() => sortPubs(pubs, sort), [pubs, sort]);
  const { visible, hasMore, showMore, rangeLabel } = useShowMore(sorted);
  return (
    <>
      <ol className="m-0 list-none p-0" data-testid="high-impact-publications">
        {visible.map((p) => (
          <PubItem
            key={p.pmid}
            pub={p}
            who={p.people.map((x, i) => (
              <span key={`${x.cwid}-${i}`}>
                {i > 0 && "; "}
                <ScholarHoverCard cwid={x.cwid}>
                  <span className="text-foreground hover:underline">{x.name}</span>
                </ScholarHoverCard>{" "}
                ({x.position} author)
              </span>
            ))}
          />
        ))}
      </ol>
      <Footer
        range={sorted.length > 0 ? `${rangeLabel} publications` : "No publications match."}
        hasMore={hasMore}
        showMore={showMore}
      />
    </>
  );
}

function Footer({
  range,
  hasMore,
  showMore,
}: {
  range: string;
  hasMore: boolean;
  showMore: () => void;
}) {
  return (
    <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3">
      <span className="text-muted-foreground text-[13px]">{range}</span>
      {hasMore && (
        <Button type="button" variant="outline" size="sm" onClick={showMore}>
          Show 25 more
        </Button>
      )}
    </div>
  );
}

/** One publication: title, byline (matching WCM authors bold), journal and
 *  citation, then the facts line — article type, `who` (the scholar's
 *  position, or the matching scholars), citations, impact factor, date added
 *  to PubMed, DOI, PMID. */
function PubItem({ pub, who }: { pub: HighImpactPub; who: ReactNode }) {
  const idText = `${pub.id.label} ${pub.id.value}`;
  return (
    <li className="border-apollo-border flex flex-col gap-1 border-b py-3.5 last:border-b-0">
      {pub.id.href ? (
        <a
          href={pub.id.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground hover:text-apollo-maroon text-[15px] leading-[1.4] font-semibold"
        >
          <PubTitle value={pub.title} />
        </a>
      ) : (
        <PubTitle as="span" value={pub.title} className="text-[15px] leading-[1.4] font-semibold" />
      )}
      {pub.byline.length > 0 && (
        <div className="text-foreground/80 text-sm leading-[1.45]">
          {pub.byline.map((s, i) => (
            <span key={i}>
              {i > 0 && (s.gap || pub.byline[i - 1].gap ? " " : ", ")}
              <span className={s.wcm ? "text-foreground font-bold" : undefined}>{s.text}</span>
            </span>
          ))}
          .
        </div>
      )}
      <div className="text-muted-foreground text-sm">
        {pub.journal && (
          <>
            <PubJournal value={pub.journal} className="text-foreground/80" />.{" "}
          </>
        )}
        {pub.cite}
      </div>
      <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
        {pub.articleType && (
          <span className="bg-apollo-surface-2 border-apollo-border-strong text-foreground/80 rounded border px-1.5 py-px whitespace-nowrap">
            {pub.articleType}
          </span>
        )}
        <span>{who}</span>
        <span className="whitespace-nowrap">
          {pub.citations === null
            ? "No citation count"
            : `${pub.citations.toLocaleString()} ${pub.citations === 1 ? "citation" : "citations"}`}
        </span>
        {pub.jif !== null && (
          <span className="whitespace-nowrap">Impact factor {pub.jif.toFixed(1)}</span>
        )}
        {pub.dateAdded && (
          <span className="whitespace-nowrap">Added to PubMed {pub.dateAdded}</span>
        )}
        {pub.doi && (
          <a
            href={`https://doi.org/${pub.doi}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-apollo-slate break-all hover:underline"
          >
            DOI {pub.doi}
          </a>
        )}
        {pub.id.href ? (
          <a
            href={pub.id.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-apollo-slate whitespace-nowrap hover:underline"
          >
            {idText}
          </a>
        ) : (
          <span className="whitespace-nowrap">{idText}</span>
        )}
      </div>
    </li>
  );
}
