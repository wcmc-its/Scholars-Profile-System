/**
 * Single paper card in the topic-page Recent highlights surface.
 *
 * Server Component. Anatomy per 02-UI-SPEC.md §"/topics/{slug} — Recent
 * highlights":
 *   - Paper title (15px / weight 600, 2-line clamp) — links to PubMed via
 *     pubmedUrl, falling back to DOI, falling back to a no-op anchor.
 *   - Author chip row: first 3 WCM authors as pill links (or plain pills for
 *     non-WCM authors with NULL slug); ellipsis if more.
 *   - Journal · year metadata line (13px muted).
 *   - NO citation count — locked by design spec v1.7.1.
 *
 * Author-chip pattern mirrors app/(public)/scholars/[slug]/page.tsx:327-339
 * for visual consistency across surfaces.
 */
import type { RecentHighlight } from "@/lib/api/topics";

export function RecentHighlightCard({ paper }: { paper: RecentHighlight }) {
  const href = paper.pubmedUrl ?? paper.doi ?? "#";
  const isExternal = href !== "#";
  const visibleAuthors = paper.authors.slice(0, 3);
  const hasMore = paper.authors.length > 3;

  return (
    <article>
      <a
        href={href}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        className="block text-base font-semibold leading-snug line-clamp-2 hover:underline"
      >
        {paper.title}
      </a>
      {visibleAuthors.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {visibleAuthors.map((a, i) =>
            a.slug ? (
              <a
                key={`${a.slug}-${i}`}
                href={`/scholars/${a.slug}`}
                className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-sm hover:bg-zinc-200"
              >
                {a.preferredName}
              </a>
            ) : (
              <span
                key={`unaff-${i}`}
                className="rounded-full bg-zinc-50 px-2.5 py-0.5 text-sm text-muted-foreground"
              >
                {a.preferredName}
              </span>
            ),
          )}
          {hasMore ? (
            <span className="text-sm text-muted-foreground">…</span>
          ) : null}
        </div>
      ) : null}
      <div className="mt-1 text-sm text-muted-foreground">
        {paper.journal ?? ""}
        {paper.year !== null ? ` · ${paper.year}` : ""}
      </div>
    </article>
  );
}
