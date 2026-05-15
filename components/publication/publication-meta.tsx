"use client";

import { useState, type ReactNode } from "react";
import { CopyButton } from "@/components/publication/copy-button";
import { HoverTooltip } from "@/components/ui/hover-tooltip";

/**
 * Unified publication-card metadata row (#87). Renders, in order:
 *   PMID · PMCID · DOI · role · citations · impact · Abstract
 *
 * Identifiers lead the row (canonical references first), then role, then
 * citation count and impact-score numbers. The optional Abstract trigger
 * (#288 PR-A) sits at the trailing edge as a peer link — same style as
 * PMID/PMC/DOI — that reveals the inline abstract snippet below the row
 * on click. Adjacent middot separators collapse so a publication missing
 * an identifier never shows `· ·`.
 *
 * Client component because the abstract toggle and "show more" inside it
 * own local UI state. Server-rendered children (`role` ReactNode, etc.)
 * pass through fine — Next.js treats them as opaque rendered trees.
 *
 * Surfaces pass `role` as a pre-rendered node (badge, plain text, or null);
 * the component owns gap, separator, and identifier-link semantics.
 *
 * `impactScore` / `conceptImpactScore` (issue #284, refs #259 §1.8) render
 * a single nowrap block so `Impact: 42 · Concept: 38` never line-breaks
 * mid-pair on mobile. Both null/undefined → block omitted. Only surfaces
 * with §1.8 data pass these; other callers leave them undefined.
 *
 * `impactJustification` (issue #316 PR-C) — when present alongside a
 * non-null `impactScore`, the inline `Impact: NN` becomes a hover/focus
 * tooltip trigger revealing the GPT-generated rubric justification.
 * Skipped when impactScore is null (nothing to explain).
 *
 * `abstract` (issue #288 PR-A) — when non-null, appends an "Abstract" link
 * to the row. Click reveals the abstract clamped at 3 lines with a
 * "Show more" toggle for the full text. Hidden when abstract is null,
 * matching the disappear-when-missing pattern of DOI / PMC. Pass
 * `defaultAbstractOpen` to ship a surface with the abstract expanded by
 * default (reserved for future per-surface tuning; default is false).
 */
export function PublicationMeta({
  citationCount,
  impactScore,
  impactJustification,
  conceptImpactScore,
  role,
  pmid,
  pmcid,
  doi,
  abstract,
  defaultAbstractOpen = false,
  className,
}: {
  citationCount?: number | null;
  impactScore?: number | null;
  impactJustification?: string | null;
  conceptImpactScore?: number | null;
  role?: ReactNode;
  pmid?: string | null;
  pmcid?: string | null;
  doi?: string | null;
  abstract?: string | null;
  defaultAbstractOpen?: boolean;
  className?: string;
}) {
  const [abstractOpen, setAbstractOpen] = useState(defaultAbstractOpen);
  const [abstractExpanded, setAbstractExpanded] = useState(false);

  const blocks: ReactNode[] = [];

  if (pmid) {
    blocks.push(
      <span key="pmid" className="inline-flex items-center">
        PMID:{" "}
        <a
          href={`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`PubMed record ${pmid}`}
          className="ml-0.5 underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
        >
          {pmid}
        </a>
        <CopyButton value={pmid} label={`Copy PMID ${pmid}`} />
      </span>,
    );
  }

  if (pmcid) {
    blocks.push(
      <span key="pmcid" className="inline-flex items-center">
        PMCID:{" "}
        <a
          href={`https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`PubMed Central record ${pmcid}`}
          className="ml-0.5 underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
        >
          {pmcid}
        </a>
        <CopyButton value={pmcid} label={`Copy PMCID ${pmcid}`} />
      </span>,
    );
  }

  if (doi) {
    blocks.push(
      <a
        key="doi"
        href={`https://doi.org/${doi}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`DOI ${doi}`}
        className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
      >
        DOI
      </a>,
    );
  }

  if (role) {
    blocks.push(<span key="role">{role}</span>);
  }

  if (citationCount && citationCount > 0) {
    blocks.push(
      <span key="cite" className="font-medium text-zinc-700 dark:text-zinc-300">
        {citationCount.toLocaleString()} citations
      </span>,
    );
  }

  const hasImpact = impactScore !== null && impactScore !== undefined;
  const hasConcept =
    conceptImpactScore !== null && conceptImpactScore !== undefined;
  const hasJustification =
    typeof impactJustification === "string" && impactJustification.length > 0;
  if (hasImpact || hasConcept) {
    const impactValue = hasImpact ? (
      <>Impact: {Math.round(impactScore as number)}</>
    ) : null;
    blocks.push(
      <span key="impact" className="whitespace-nowrap">
        {hasImpact && hasJustification ? (
          <HoverTooltip text={impactJustification as string} wide>
            <span tabIndex={0} className="cursor-help">
              {impactValue}
            </span>
          </HoverTooltip>
        ) : (
          impactValue
        )}
        {hasImpact && hasConcept ? (
          <span aria-hidden="true" className="text-muted-foreground/60">
            {" · "}
          </span>
        ) : null}
        {hasConcept ? <>Concept: {Math.round(conceptImpactScore as number)}</> : null}
      </span>,
    );
  }

  const hasAbstract = typeof abstract === "string" && abstract.length > 0;
  if (hasAbstract) {
    blocks.push(
      <button
        key="abstract"
        type="button"
        onClick={() => setAbstractOpen((s) => !s)}
        aria-expanded={abstractOpen}
        className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
      >
        Abstract
      </button>,
    );
  }

  if (blocks.length === 0) return null;

  const interleaved: ReactNode[] = [];
  blocks.forEach((b, i) => {
    if (i > 0) {
      interleaved.push(
        <span
          key={`sep-${i}`}
          aria-hidden="true"
          className="text-muted-foreground/60"
        >
          ·
        </span>,
      );
    }
    interleaved.push(b);
  });

  const row = (
    <div
      className={
        className ??
        "text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
      }
    >
      {interleaved}
    </div>
  );

  if (!hasAbstract || !abstractOpen) return row;

  return (
    <>
      {row}
      <div className="mt-2">
        <p
          className={`text-sm leading-relaxed text-foreground/90 ${
            abstractExpanded ? "" : "line-clamp-3"
          }`}
        >
          {abstract}
        </p>
        <button
          type="button"
          onClick={() => setAbstractExpanded((s) => !s)}
          aria-expanded={abstractExpanded}
          className="mt-1 text-xs text-[var(--color-accent-slate)] hover:underline"
        >
          {abstractExpanded ? "Show less" : "Show more"}
        </button>
      </div>
    </>
  );
}
