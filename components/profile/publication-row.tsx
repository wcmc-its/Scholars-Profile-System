"use client";

import { AuthorChipRow } from "@/components/publication/author-chip-row";
import { pubTitleProps } from "@/components/publication/pub-html";
import { PublicationMeta } from "@/components/publication/publication-meta";
import { usePublicationModal } from "@/components/publication/publication-modal";
import {
  AuthorPositionBadge,
  deriveAuthorPositionRole,
} from "@/components/profile/author-position-badge";
import type { ProfileRowPublication } from "@/lib/profile/client-publication";
import { sanitizePubTitle } from "@/lib/utils";

/** OpenAlex-lane publication types (accepted from the AAR openalex queue) that
 *  get a type label on the row, since the venue line alone doesn't say the work
 *  isn't a peer-reviewed article. Every other type renders no label. */
const PUBLICATION_TYPE_LABELS: Readonly<Record<string, string>> = {
  "conference-abstract": "Conference abstract",
  preprint: "Preprint",
};

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
              className="italic"
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
      <PublicationMeta
        citationCount={pub.citationCount}
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
