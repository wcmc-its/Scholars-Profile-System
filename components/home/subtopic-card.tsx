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
import type { SubtopicCard as SubtopicCardData } from "@/lib/api/home";

export function SubtopicCard({ item }: { item: SubtopicCardData }) {
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col px-4 py-4">
        <div className="text-muted-foreground text-sm">{item.parentTopicName}</div>
        <a
          href={`/topics/${item.subtopicSlug}`}
          className="mt-1 block text-base font-semibold hover:underline"
        >
          {item.subtopicName}
        </a>
        <div className="text-muted-foreground mt-1 text-sm">
          {item.scholarCount} scholars · {item.publicationCount} publications
        </div>
        {item.publications.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-3">
            {item.publications.map((p) => (
              <li key={p.pmid}>
                <div className="line-clamp-2 text-sm font-semibold">{p.title}</div>
                {p.firstWcmAuthor ? (
                  <a
                    href={`/scholars/${p.firstWcmAuthor.slug}`}
                    className="mt-1 inline-block rounded-full bg-zinc-100 px-2 py-0.5 text-sm hover:bg-zinc-200"
                  >
                    {p.firstWcmAuthor.preferredName}
                  </a>
                ) : null}
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
