"use client";

/**
 * Report 8's Articles tab list (reports redesign): one citation per counted
 * article — title (PubMed link), authors with the matching scholars in bold
 * (each in `ScholarHoverCard`), journal and volume / issue / pages, a "WCM
 * authors:" line for matching scholars the byline could not place, then the
 * article type, impact factor, PMID and DOI. Sorted client-side (Newest
 * first / Journal Impact Factor / Journal A–Z) and paged "Show 25 more"
 * (`useShowMore`). The body loads the rows only at or under the list cap;
 * above it the body renders the "too many" panel instead of this list.
 * Type-only imports from the server side; nothing here reaches `@/lib/db`.
 */
import { useMemo, useState, type ReactNode } from "react";

import { useShowMore } from "@/components/edit/reports/report-show-more";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Button } from "@/components/ui/button";

export type CitationRow = {
  key: string;
  /** The PubMed title, inline markup kept (rendered through `PubTitle`). */
  title: string;
  /** The title's link (PubMed), or null for a non-PubMed record. */
  href: string | null;
  /** Author tokens as shown; a `cwid` marks a matching scholar (bold). "…"
   *  stands for authors left out of a long list. */
  authors: { text: string; cwid?: string }[];
  /** Matching scholars the author list does not place (no known author
   *  rank): shown on a "WCM authors:" line so none goes missing. */
  otherScholars: { cwid: string; name: string }[];
  journal: string | null;
  /** `2024;12(3):1-9`. */
  source: string | null;
  type: string | null;
  jif: number | null;
  id: { label: string; value: string; href: string | null };
  doi: string | null;
  /** The report-basis year (sorting). */
  year: number;
  dateAdded: string | null;
};

export type CitationSort = "new" | "jif" | "journal";

const SORT_LABEL: Record<CitationSort, string> = {
  new: "Newest first",
  jif: "Journal Impact Factor",
  journal: "Journal A–Z",
};

const newest = (a: CitationRow, b: CitationRow) =>
  b.year - a.year || (b.dateAdded ?? "").localeCompare(a.dateAdded ?? "") || b.key.localeCompare(a.key);

const COMPARE: Record<CitationSort, (a: CitationRow, b: CitationRow) => number> = {
  new: newest,
  jif: (a, b) => (b.jif ?? -1) - (a.jif ?? -1) || newest(a, b),
  journal: (a, b) =>
    (a.journal === null ? 1 : 0) - (b.journal === null ? 1 : 0) ||
    (a.journal ?? "").localeCompare(b.journal ?? "", undefined, { sensitivity: "base" }) ||
    newest(a, b),
};

export function ArticleCitationList({
  rows,
  yearChip,
  showDateAdded = false,
}: {
  rows: CitationRow[];
  /** The Year pick's chip (`Year: 2024` + its remove link), beside the range label. */
  yearChip?: ReactNode;
  /** Each row states its PubMed add date (the date-added window). */
  showDateAdded?: boolean;
}) {
  const [sort, setSort] = useState<CitationSort>("new");
  const sorted = useMemo(() => [...rows].sort(COMPARE[sort]), [rows, sort]);
  const { visible, hasMore, showMore } = useShowMore(sorted);

  return (
    <div data-testid="article-citations">
      <div className="flex flex-wrap items-center justify-between gap-3 py-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-muted-foreground text-sm tabular-nums" data-testid="article-range">
            {rows.length === 0
              ? "No articles match"
              : `Showing 1–${visible.length.toLocaleString()} of ${rows.length.toLocaleString()}`}
          </span>
          {yearChip}
        </div>
        {rows.length > 0 && (
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground text-[13px]">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as CitationSort)}
              className="border-apollo-border-strong bg-apollo-surface h-8 rounded-md border px-2 text-[13px]"
              data-testid="article-sort"
            >
              {(Object.keys(SORT_LABEL) as CitationSort[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {rows.length > 0 && (
        <ol className="border-apollo-border m-0 list-none border-t p-0">
          {visible.map((c) => (
            <li key={c.key} className="border-apollo-border flex flex-col gap-1.5 border-b py-4" data-testid="article-row">
              {c.href ? (
                <a
                  href={c.href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground hover:text-apollo-maroon text-[15px] leading-[1.4] font-semibold break-words"
                >
                  <PubTitle value={c.title} />
                </a>
              ) : (
                <PubTitle value={c.title} className="text-foreground text-[15px] leading-[1.4] font-semibold break-words" />
              )}
              {c.authors.length > 0 && (
                <p className="text-apollo-ink-2 text-sm leading-[1.45] break-words">
                  {c.authors.map((a, i) => (
                    <span key={i}>
                      {a.cwid ? (
                        <ScholarHoverCard cwid={a.cwid}>
                          <strong className="text-foreground font-bold">{a.text}</strong>
                        </ScholarHoverCard>
                      ) : (
                        a.text
                      )}
                      {i < c.authors.length - 1 ? ", " : "."}
                    </span>
                  ))}
                </p>
              )}
              {(c.journal || c.source) && (
                <p className="text-muted-foreground text-sm">
                  <PubJournal value={c.journal} className="text-apollo-ink-2 italic" />
                  {c.journal && c.source ? ". " : ""}
                  {c.source && `${c.source}.`}
                </p>
              )}
              {c.otherScholars.length > 0 && (
                <p className="text-apollo-ink-2 text-sm break-words" data-testid="article-other-scholars">
                  <span className="text-muted-foreground">WCM authors: </span>
                  {c.otherScholars.map((o, i) => (
                    <span key={o.cwid}>
                      <ScholarHoverCard cwid={o.cwid}>
                        <strong className="text-foreground font-bold">{o.name}</strong>
                      </ScholarHoverCard>
                      {i < c.otherScholars.length - 1 ? ", " : ""}
                    </span>
                  ))}
                </p>
              )}
              <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {c.type && (
                  <span className="bg-apollo-surface-2 border-apollo-border-strong text-apollo-ink-2 rounded border px-1.5 py-px">
                    {c.type}
                  </span>
                )}
                <span className="tabular-nums">{c.jif === null ? "No JIF on file" : `JIF ${c.jif.toFixed(1)}`}</span>
                {c.id.href ? (
                  <a href={c.id.href} target="_blank" rel="noreferrer" className="text-apollo-slate tabular-nums hover:underline">
                    {c.id.label} {c.id.value}
                  </a>
                ) : (
                  <span className="tabular-nums">
                    {c.id.label} {c.id.value}
                  </span>
                )}
                {c.doi && (
                  <a
                    href={`https://doi.org/${c.doi}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-apollo-slate hover:underline"
                  >
                    DOI
                  </a>
                )}
                {showDateAdded && c.dateAdded && <span className="tabular-nums">Added to PubMed {c.dateAdded}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {hasMore && (
        <div className="mt-4 flex justify-center">
          <Button type="button" variant="outline" size="sm" onClick={showMore}>
            Show 25 more
          </Button>
        </div>
      )}
    </div>
  );
}
