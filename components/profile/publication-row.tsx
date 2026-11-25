"use client";

import { AuthorChipRow } from "@/components/publication/author-chip-row";
import { pubTitleProps } from "@/components/publication/pub-html";
import { PublicationMeta } from "@/components/publication/publication-meta";
import { usePublicationModal } from "@/components/publication/publication-modal";
import {
  AuthorPositionBadge,
  deriveAuthorPositionRole,
} from "@/components/profile/author-position-badge";
import { Landmark } from "lucide-react";
import { authorityBadgeLabel, plural } from "@/lib/citations/policy-rollup";
import type { ProfileRowPublication } from "@/lib/profile/client-publication";
import { sanitizePubTitle } from "@/lib/utils";

/** OpenAlex-lane publication types (accepted from the AAR openalex queue) that
 *  get a type label on the row, since the venue line alone doesn't say the work
 *  isn't a peer-reviewed article. Every other type renders no label. */
const PUBLICATION_TYPE_LABELS: Readonly<Record<string, string>> = {
  "conference-abstract": "Conference abstract",
  // Proceedings venues (e.g. a lecture-notes series) read like journals without it.
  "conference-paper": "Conference paper",
  preprint: "Preprint",
  // Books, in each source's vocabulary (Crossref / OpenAlex lowercase, Scopus
  // subtypeDescription). Without a label a book reads as an article in a
  // journal named after its publisher.
  book: "Book",
  "edited-book": "Book",
  monograph: "Book",
  "reference-book": "Book",
  Book: "Book",
  "book-chapter": "Book chapter",
  "Book Chapter": "Book chapter",
};

/** A whole book: its venue line is the publisher, not a journal, so it is not italicized. */
export function isWholeBook(publicationType: string | null | undefined): boolean {
  return publicationTypeLabel(publicationType) === "Book";
}

export function publicationTypeLabel(publicationType: string | null | undefined): string | null {
  return publicationType ? (PUBLICATION_TYPE_LABELS[publicationType] ?? null) : null;
}

/**
 * Render a single profile publication row. Client component because the
 * title is a modal trigger (#288 PR-B). The embedded `<AuthorChipRow>`
 * already brought its own client interactivity (tooltip); the row chrome
 * is otherwise structural.
 *
 * Title click opens the publication detail modal in place of the previous
 * `<a href={pubmedUrl}>` navigation. PubMed is still reachable via the
 * PMID link in the meta row and inside the modal itself, so users who
 * want the upstream record still have a one-click path.
 */
export function PublicationRow({
  pub,
  compact = false,
  currentProfileCwid,
}: {
  pub: ProfileRowPublication;
  compact?: boolean;
  /** The cwid of the scholar whose profile this row is rendered on. Drives
   *  PersonPopover's self-hover guard and co-author surface routing (#242). */
  currentProfileCwid?: string;
}) {
  // Role derivation lives in `author-position-badge.tsx` so the Position
  // filter (#72) and the per-row badge agree. Co-first / co-last detection
  // (#18) compares the full WCM author list against authorship flags.
  const role = deriveAuthorPositionRole(pub.authorship, pub.wcmAuthors);
  const typeLabel = publicationTypeLabel(pub.publicationType);
  const titleHtml = sanitizePubTitle(pub.title);
  const { open } = usePublicationModal();
  const policy = pub.policy;
  const openPolicy = () => open(pub.pmid, { section: "policy" });
  const badge = "inline-flex min-h-6 items-center gap-[5px] rounded-full border px-2.5 text-xs font-medium";
  return (
    <div>
      <div
        className={
          compact
            ? "text-base font-medium leading-snug"
            : "text-base font-semibold leading-snug"
        }
      >
        <button
          type="button"
          onClick={() => open(pub.pmid)}
          aria-haspopup="dialog"
          {...pubTitleProps(
            titleHtml,
            "text-left hover:text-[var(--color-accent-slate)] hover:underline",
          )}
        />
      </div>
      {pub.journal || pub.year ? (
        <div className="mt-1 text-sm leading-snug text-zinc-700 dark:text-zinc-300">
          {pub.journal ? (
            <em
              className={isWholeBook(pub.publicationType) ? "not-italic" : "italic"}
              dangerouslySetInnerHTML={{ __html: sanitizePubTitle(pub.journal) }}
            />
          ) : null}
          {pub.year ? ` · ${pub.year}` : ""}
        </div>
      ) : null}
      <AuthorChipRow
        authors={pub.wcmAuthors}
        pmid={pub.pmid}
        currentProfileCwid={currentProfileCwid}
      />
      {policy && (policy.authority.length > 0 || policy.guidelines > 0) ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {policy.authority.map((a) => (
            <button
              key={a.body}
              type="button"
              onClick={openPolicy}
              aria-haspopup="dialog"
              className={`${badge} border-[var(--color-accent-slate)] bg-[var(--color-accent-slate)] text-white hover:opacity-90`}
            >
              <Landmark className="size-3" strokeWidth={2} aria-hidden="true" />
              {authorityBadgeLabel(a.body, a.count)}
            </button>
          ))}
          {policy.guidelines > 0 ? (
            <button
              type="button"
              onClick={openPolicy}
              aria-haspopup="dialog"
              className={`${badge} border-[#d5e0ec] bg-[#ecf1f6] text-[#274158] hover:border-[var(--color-accent-slate)]`}
            >
              {plural(policy.guidelines, "clinical guideline", "clinical guidelines")}
            </button>
          ) : null}
        </div>
      ) : null}
      <PublicationMeta
        citationCount={pub.citationCount}
        reviewCount={policy?.reviews}
        role={
          role || typeLabel ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {typeLabel ? (
                <span className="author-position-badge bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {typeLabel}
                </span>
              ) : null}
              <AuthorPositionBadge role={role} />
            </span>
          ) : null
        }
        pmid={pub.pmid}
        pmcid={pub.pmcid}
        doi={pub.doi}
        ecommonsLink={pub.ecommonsLink}
        lazyAbstract={pub.hasAbstract}
      />
    </div>
  );
}
