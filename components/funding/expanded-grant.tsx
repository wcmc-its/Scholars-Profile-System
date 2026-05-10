"use client";

import { useState } from "react";
import { sanitizePubTitle } from "@/lib/utils";
import { HoverTooltip } from "@/components/ui/hover-tooltip";

/**
 * Shared expand UX for grant rows. Used by:
 *   - profile Funding section (components/profile/grants-section.tsx)
 *   - funding search results (components/search/funding-result-row.tsx)
 *
 * Renders the abstract (truncated with Show more), the top N pubs sorted
 * year-desc → citationCount-desc, "Show N more" inline pagination, and
 * outbound PubMed + RePORTER links. Pubs whose isLowerConfidence flag is
 * set get a tooltip badge.
 *
 * The caller is responsible for the chevron toggle button — this
 * component only renders the panel that appears when expanded.
 */

const PUBS_INITIAL = 5;
const ABSTRACT_TRUNCATE_LINES = 3;

/** Label for the chevron-prefixed expand button. Single source of truth
 *  used by both the profile grant rows and the funding search rows so
 *  the wording stays consistent across surfaces. */
export function expandLabel(pubCount: number, hasAbstract: boolean): string {
  const pubs = `${pubCount} ${pubCount === 1 ? "publication" : "publications"}`;
  if (pubCount > 0 && hasAbstract) return `Abstract & ${pubs}`;
  if (pubCount > 0) return pubs;
  return "Abstract";
}

export type GrantPubItem = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  citationCount: number;
  isLowerConfidence: boolean;
};

/**
 * Issue #92 — display label for the abstract source. Slugs map to
 * publishable agency/funder names; unknown slugs fall through verbatim
 * (defensive: future sources won't break the UI).
 */
const ABSTRACT_SOURCE_LABEL: Record<string, string> = {
  reporter: "NIH RePORTER",
  nsf: "NSF",
  pcori: "PCORI",
  cdmrp: "DOD CDMRP",
  gates: "Gates Foundation",
};

export function ExpandedGrant({
  abstract,
  abstractSource,
  applId,
  coreProjectNum,
  publications,
  /** Optional indent on the left, matching the parent row's gutter.
   *  Profile passes "ml-[76px]" to align with the role pill column;
   *  search results pass nothing for a flush-left expansion. */
  indentClass = "",
}: {
  abstract: string | null;
  /** Issue #92 — origin slug for the abstract; renders as small
   *  attribution under the abstract block. Optional for backwards
   *  compatibility — older callers that don't pass it just hide the line. */
  abstractSource?: string | null;
  applId: number | null;
  coreProjectNum: string | null;
  publications: GrantPubItem[];
  indentClass?: string;
}) {
  const [showAbstract, setShowAbstract] = useState(false);
  const [showAllPubs, setShowAllPubs] = useState(false);
  const pubs = showAllPubs ? publications : publications.slice(0, PUBS_INITIAL);
  const hiddenCount = publications.length - PUBS_INITIAL;

  const reporterUrl = applId ? `https://reporter.nih.gov/project-details/${applId}` : null;
  // PubMed query returns any pub citing this grant. Uses core_project_num
  // which PubMed accepts for grant searches across all renewal years.
  const pubmedUrl = coreProjectNum
    ? `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(coreProjectNum)}%5BGrants+and+Funding%5D`
    : null;

  return (
    <div className={`mb-3 border-l-2 border-border pl-3 ${indentClass}`}>
      {abstract ? (
        <div className="mb-3">
          <p
            className={`text-sm leading-relaxed text-foreground/90 ${
              showAbstract ? "" : `line-clamp-${ABSTRACT_TRUNCATE_LINES}`
            }`}
          >
            {abstract}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
            <button
              type="button"
              onClick={() => setShowAbstract((s) => !s)}
              className="text-[var(--color-accent-slate)] hover:underline"
            >
              {showAbstract ? "Show less" : "Show more"}
            </button>
            {abstractSource ? (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">
                  Source: {ABSTRACT_SOURCE_LABEL[abstractSource] ?? abstractSource}
                </span>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {pubs.length > 0 ? (
        <ul className="flex flex-col gap-2.5">
          {pubs.map((p) => (
            <li key={p.pmid}>
              <div className="text-sm leading-snug">
                <a
                  href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-accent-slate)] hover:underline"
                  dangerouslySetInnerHTML={{ __html: sanitizePubTitle(p.title) }}
                />
                {p.isLowerConfidence ? <LowerConfidenceBadge /> : null}
              </div>
              <div className="text-muted-foreground mt-0.5 text-xs">
                {p.journal ? <em>{p.journal}</em> : null}
                {p.year ? <> · {p.year}</> : null}
                {" · PMID "}
                {p.pmid}
                {p.citationCount > 0 ? (
                  <>
                    {" · "}
                    {p.citationCount} {p.citationCount === 1 ? "citation" : "citations"}
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {hiddenCount > 0 || pubmedUrl || reporterUrl ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs">
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAllPubs((s) => !s)}
              className="text-[var(--color-accent-slate)] hover:underline"
            >
              {showAllPubs ? "Show fewer" : `Show ${hiddenCount} more`}
            </button>
          ) : null}
          {hiddenCount > 0 && (pubmedUrl || reporterUrl) ? (
            <span className="text-muted-foreground">·</span>
          ) : null}
          {pubmedUrl ? (
            <a
              href={pubmedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-accent-slate)] hover:underline"
            >
              PubMed
            </a>
          ) : null}
          {pubmedUrl && reporterUrl ? <span className="text-muted-foreground">·</span> : null}
          {reporterUrl ? (
            <a
              href={reporterUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-accent-slate)] hover:underline"
            >
              RePORTER
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function LowerConfidenceBadge() {
  return (
    <HoverTooltip text="Found via PubMed grant indexing only; not yet confirmed by NIH RePORTER. Attribution may need review.">
      <span className="ml-2 inline-flex h-4 items-center rounded-sm border border-amber-300 bg-amber-50 px-1.5 text-[10px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
        Lower confidence
      </span>
    </HoverTooltip>
  );
}
