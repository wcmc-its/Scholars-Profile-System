"use client";

import { AuthorChipRow } from "@/components/publication/author-chip-row";
import { PublicationMeta } from "@/components/publication/publication-meta";
import { usePublicationModal } from "@/components/publication/publication-modal";
import {
  AuthorPositionBadge,
  deriveAuthorPositionRole,
} from "@/components/profile/author-position-badge";
import type { ProfilePublication } from "@/lib/api/profile";
import { sanitizePubTitle } from "@/lib/utils";

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
  pub: ProfilePublication;
  compact?: boolean;
  /** The cwid of the scholar whose profile this row is rendered on. Drives
   *  PersonPopover's self-hover guard and co-author surface routing (#242). */
  currentProfileCwid?: string;
}) {
  // Role derivation lives in `author-position-badge.tsx` so the Position
  // filter (#72) and the per-row badge agree. Co-first / co-last detection
  // (#18) compares the full WCM author list against authorship flags.
  const role = deriveAuthorPositionRole(pub.authorship, pub.wcmAuthors);
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
          className="text-left hover:text-[var(--color-accent-slate)] hover:underline"
          dangerouslySetInnerHTML={{ __html: titleHtml }}
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
        role={role ? <AuthorPositionBadge role={role} /> : null}
        pmid={pub.pmid}
        pmcid={pub.pmcid}
        doi={pub.doi}
        abstract={pub.abstract}
      />
    </div>
  );
}
