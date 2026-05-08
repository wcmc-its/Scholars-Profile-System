import { AuthorChipRow } from "@/components/publication/author-chip-row";
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
  // Co-first / co-last detection uses the full author list on the pub —
  // when ≥2 authors share isFirst (or isLast), surface the co- variant. (#18)
  const firstCount = pub.wcmAuthors.filter((a) => a.isFirst).length;
  const lastCount = pub.wcmAuthors.filter((a) => a.isLast).length;
  const role = pub.authorship.isFirst && pub.authorship.isLast
    ? "First and senior author"
    : pub.authorship.isLast
    ? lastCount > 1
      ? "Co-last author"
      : "Senior author"
    : pub.authorship.isFirst
    ? firstCount > 1
      ? "Co-first author"
      : "First author"
    : null;
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
        {role ? <span>{role}</span> : null}
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
