import { AuthorChipRow } from "@/components/publication/author-chip-row";
import {
  AuthorPositionBadge,
  deriveAuthorPositionRole,
} from "@/components/profile/author-position-badge";
import type { ProfilePublication } from "@/lib/api/profile";
import { sanitizePubTitle } from "@/lib/utils";

/**
 * Render a single profile publication row. Server-or-client compatible — no
 * hooks, no "use client" directive. The embedded `<AuthorChipRow>` handles
 * the chip-row interactivity (tooltip) on its own.
 */
export function PublicationRow({
  pub,
  compact = false,
}: {
  pub: ProfilePublication;
  compact?: boolean;
}) {
  // Role derivation lives in `author-position-badge.tsx` so the Position
  // filter (#72) and the per-row badge agree. Co-first / co-last detection
  // (#18) compares the full WCM author list against authorship flags.
  const role = deriveAuthorPositionRole(pub.authorship, pub.wcmAuthors);
  const titleHtml = sanitizePubTitle(pub.title);
  return (
    <div>
      <div
        className={
          compact
            ? "text-base font-medium leading-snug"
            : "text-base font-semibold leading-snug"
        }
      >
        {pub.pubmedUrl ? (
          <a
            href={pub.pubmedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-[var(--color-accent-slate)] hover:underline"
            dangerouslySetInnerHTML={{ __html: titleHtml }}
          />
        ) : (
          <span dangerouslySetInnerHTML={{ __html: titleHtml }} />
        )}
      </div>
      {pub.journal || pub.year ? (
        <div className="mt-1 text-sm leading-snug text-zinc-700 dark:text-zinc-300">
          {pub.journal ? <em className="italic">{pub.journal}</em> : null}
          {pub.year ? ` · ${pub.year}` : ""}
        </div>
      ) : null}
      <AuthorChipRow authors={pub.wcmAuthors} />
      <div className="text-muted-foreground mt-1.5 flex flex-wrap gap-x-3 text-xs">
        {pub.citationCount > 0 ? (
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {pub.citationCount.toLocaleString()} citations
          </span>
        ) : null}
        <AuthorPositionBadge role={role} />
        {pub.doi ? (
          <a
            href={`https://doi.org/${pub.doi}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted hover:text-[var(--color-accent-slate)]"
          >
            DOI
          </a>
        ) : null}
      </div>
    </div>
  );
}
