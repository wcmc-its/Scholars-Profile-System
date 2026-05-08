/**
 * Single subtopic card inside the Selected research carousel.
 *
 * Server Component. Renders parent breadcrumb, subtopic name link,
 * scholar/publication counts, up to 2 publications with WCM author chips,
 * and the "Selected by ReCiterAI · methodology" footnote (per sketch 003
 * Variant D). Methodology link uses METHODOLOGY_ANCHORS.selectedResearch.
 */
import { Card, CardContent } from "@/components/ui/card";
import { METHODOLOGY_BASE, METHODOLOGY_ANCHORS } from "@/lib/methodology-anchors";
import { sanitizePubmedHtml } from "@/lib/utils";
import type { SubtopicCard as SubtopicCardData } from "@/lib/api/home";

export function SubtopicCard({ item }: { item: SubtopicCardData }) {
  return (
    <Card className="group h-full cursor-pointer transition-all duration-150 hover:border-[var(--color-accent-slate)] hover:shadow-md">
      <CardContent className="flex h-full flex-col px-4 py-4">
        <div className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">{item.parentTopicName}</div>
        <a
          href={`/topics/${item.parentTopicSlug}?subtopic=${encodeURIComponent(item.subtopicSlug)}#publications`}
          className="mt-2 block text-base font-semibold leading-snug text-zinc-900 hover:underline group-hover:text-[var(--color-accent-slate)]"
        >
          {item.subtopicName}
        </a>
        {item.subtopicShortDescription ? (
          <p className="text-muted-foreground mt-1 line-clamp-1 text-sm">
            {item.subtopicShortDescription}
          </p>
        ) : null}
        <div className="text-muted-foreground mt-1 text-sm">
          {item.publicationCount} publications · {item.scholarCount} scholars
        </div>
        {item.publications.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-3">
            {item.publications.map((p) => (
              <li key={p.pmid}>
                <div
                  className="line-clamp-2 text-sm font-semibold"
                  dangerouslySetInnerHTML={{ __html: sanitizePubmedHtml(p.title) }}
                />
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {p.firstWcmAuthor ? (
                    <a
                      href={`/scholars/${p.firstWcmAuthor.slug}`}
                      className="inline-block rounded-full bg-zinc-100 px-2 py-0.5 text-sm hover:bg-zinc-200"
                    >
                      {p.firstWcmAuthor.preferredName}
                    </a>
                  ) : null}
                  {(p.journal || p.year) ? (
                    <span className="text-muted-foreground text-xs italic">
                      {p.journal ? (
                        <span
                          dangerouslySetInnerHTML={{
                            __html: sanitizePubmedHtml(p.journal),
                          }}
                        />
                      ) : null}
                      {p.journal && p.year ? " · " : null}
                      {p.year ? <span>{p.year}</span> : null}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-muted-foreground mt-auto pt-3 text-sm italic">
          Selected by ReCiterAI ·{" "}
          <a
            href={`${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS.selectedResearch}`}
            className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
          >
            methodology
          </a>
        </p>
      </CardContent>
    </Card>
  );
}
