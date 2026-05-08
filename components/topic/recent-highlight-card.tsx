/**
 * Single paper card in the topic-page Recent highlights surface.
 *
 * Server Component. Layout per 02-UI-SPEC.md §"/topics/{slug} — Recent highlights":
 *   - Bold linked title (3-line clamp), markup-aware via sanitizePubTitle.
 *   - WCM author chips with headshots (AuthorChipRow), capped low for the
 *     tight 3-card grid; remaining authors fall behind a "+N more" pill.
 *   - Italic journal · year metadata line (muted).
 *   - NO citation count — locked by design spec v1.7.1.
 */
import type { RecentHighlight } from "@/lib/api/topics";
import { AuthorChipRow } from "@/components/publication/author-chip-row";
import { sanitizePubTitle } from "@/lib/utils";

export function RecentHighlightCard({ paper }: { paper: RecentHighlight }) {
  const href = paper.pubmedUrl ?? paper.doi ?? "#";
  const isExternal = href !== "#";
  const titleHtml = sanitizePubTitle(paper.title);

  return (
    <article>
      <a
        href={href}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        className="block text-sm font-semibold leading-snug line-clamp-3 hover:underline"
        dangerouslySetInnerHTML={{ __html: titleHtml }}
      />
      <AuthorChipRow authors={paper.authors} />
      <div className="mt-1 text-xs italic text-muted-foreground">
        {[paper.journal, paper.year !== null ? String(paper.year) : null]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </article>
  );
}
