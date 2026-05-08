/**
 * Compact publication card used in the dept "Recent publications" highlights
 * row and the Publications tab full list. Server Component — no interactive
 * state. Embeds <AuthorChipRow> which is its own client island.
 */
import { AuthorChipRow } from "@/components/publication/author-chip-row";
import { sanitizePubTitle } from "@/lib/utils";
import type { DeptPublicationCard } from "@/lib/api/dept-highlights";

export function PublicationCard({ pub }: { pub: DeptPublicationCard }) {
  // Titles in `publication.title` carry inline PubMed markup (<sup>, <sub>,
  // <i>, <b>) that must render as HTML, not escaped text. sanitizePubTitle
  // whitelists the safe inline tags and strips everything else. Same
  // approach used by topic and profile pub rows.
  const titleHtml = sanitizePubTitle(pub.title);
  const meta: string[] = [];
  if (pub.journal) meta.push(pub.journal);
  if (pub.year) meta.push(String(pub.year));
  if (pub.citationCount > 0)
    meta.push(`${pub.citationCount.toLocaleString()} citations`);

  const href = pub.doi
    ? `https://doi.org/${pub.doi}`
    : (pub.pubmedUrl ?? null);

  return (
    <article className="flex flex-col">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[13px] font-medium leading-[1.4] text-[var(--color-text-primary)] hover:underline"
          style={{ textDecoration: "none" }}
          dangerouslySetInnerHTML={{ __html: titleHtml }}
        />
      ) : (
        <span
          className="text-[13px] font-medium leading-[1.4] text-[var(--color-text-primary)]"
          dangerouslySetInnerHTML={{ __html: titleHtml }}
        />
      )}
      {pub.authors.length > 0 && <AuthorChipRow authors={pub.authors} />}
      {meta.length > 0 && (
        <div className="mt-2 text-[11px] text-[var(--color-text-secondary)]">
          {pub.journal && (
            <span
              className="italic"
              dangerouslySetInnerHTML={{ __html: sanitizePubTitle(pub.journal) }}
            />
          )}
          {pub.journal && (pub.year || pub.citationCount > 0) && " · "}
          {pub.year && <span>{pub.year}</span>}
          {pub.year && pub.citationCount > 0 && " · "}
          {pub.citationCount > 0 && (
            <span>{pub.citationCount.toLocaleString()} citations</span>
          )}
        </div>
      )}
    </article>
  );
}
