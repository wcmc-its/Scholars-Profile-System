import type { ReactNode } from "react";
import { CopyButton } from "@/components/publication/copy-button";

/**
 * Unified publication-card metadata row (#87). Renders, in order:
 *   PMID · PMCID · DOI · role · citations · impact
 *
 * Identifiers lead the row (canonical references first), then role, then
 * citation count and impact-score numbers trail. Adjacent middot separators
 * collapse so a publication missing an identifier never shows `· ·`.
 * Server-compatible — the embedded `<CopyButton>` carries its own `"use client"`.
 *
 * Surfaces pass `role` as a pre-rendered node (badge, plain text, or null);
 * the component owns gap, separator, and identifier-link semantics.
 *
 * `impactScore` / `conceptImpactScore` (issue #284, refs #259 §1.8) render
 * a single nowrap block so `Impact: 42 · Concept: 38` never line-breaks
 * mid-pair on mobile. Both null/undefined → block omitted. Only surfaces
 * with §1.8 data pass these; other callers leave them undefined.
 */
export function PublicationMeta({
  citationCount,
  impactScore,
  conceptImpactScore,
  role,
  pmid,
  pmcid,
  doi,
  className,
}: {
  citationCount?: number | null;
  impactScore?: number | null;
  conceptImpactScore?: number | null;
  role?: ReactNode;
  pmid?: string | null;
  pmcid?: string | null;
  doi?: string | null;
  className?: string;
}) {
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
  if (hasImpact || hasConcept) {
    blocks.push(
      <span key="impact" className="whitespace-nowrap">
        {hasImpact ? <>Impact: {Math.round(impactScore as number)}</> : null}
        {hasImpact && hasConcept ? (
          <span aria-hidden="true" className="text-muted-foreground/60">
            {" · "}
          </span>
        ) : null}
        {hasConcept ? <>Concept: {Math.round(conceptImpactScore as number)}</> : null}
      </span>,
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

  return (
    <div
      className={
        className ??
        "text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
      }
    >
      {interleaved}
    </div>
  );
}
