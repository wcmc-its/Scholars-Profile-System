/**
 * Single paper card in the topic-page Recent highlights surface.
 *
 * Server Component. Layout per 02-UI-SPEC.md §"/topics/{slug} — Recent highlights":
 *   - Bold linked title (2-line clamp).
 *   - One author line: first WCM author (or first author) + "et al." if more.
 *   - Italic journal · year metadata line (muted).
 *   - NO citation count — locked by design spec v1.7.1.
 */
import type { RecentHighlight } from "@/lib/api/topics";

export function RecentHighlightCard({ paper }: { paper: RecentHighlight }) {
  const href = paper.pubmedUrl ?? paper.doi ?? "#";
  const isExternal = href !== "#";

  // Prefer first WCM author (has a slug); fall back to first author overall.
  const primaryAuthor =
    paper.authors.find((a) => a.slug !== null) ?? paper.authors[0] ?? null;
  const hasMore = paper.authors.length > 1;

  return (
    <article>
      <a
        href={href}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        className="block text-sm font-semibold leading-snug line-clamp-3 hover:underline"
      >
        {paper.title}
      </a>
      {primaryAuthor && (
        <div className="mt-2 text-sm text-muted-foreground">
          {primaryAuthor.slug ? (
            <a
              href={`/scholars/${primaryAuthor.slug}`}
              className="font-medium text-foreground hover:underline"
            >
              {primaryAuthor.preferredName}
            </a>
          ) : (
            <span className="font-medium text-foreground">
              {primaryAuthor.preferredName}
            </span>
          )}
          {hasMore ? " et al." : ""}
        </div>
      )}
      <div className="mt-1 text-xs italic text-muted-foreground">
        {[paper.journal, paper.year !== null ? String(paper.year) : null]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </article>
  );
}
