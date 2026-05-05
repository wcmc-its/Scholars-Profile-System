/**
 * Home-page Selected research carousel. Server Component using native CSS
 * scroll-snap (no JS required). Layout per UI-SPEC sketch 003 Variant D:
 *
 *   - Desktop ≥1024px: 3.15-card peek (`w-[calc((100%-2*16px)/3.15)]`)
 *   - Tablet 640–1023px: 2.15-card peek
 *   - Mobile <640px: 1.15-card peek
 *
 * Uses Tailwind `snap-x snap-mandatory` on the scroll container and
 * `snap-start shrink-0` on each item. No third-party carousel library.
 *
 * Sparse-state hide is the caller's responsibility (D-12 floor 4 of 8).
 */
import { SubtopicCard } from "./subtopic-card";
import { METHODOLOGY_BASE, METHODOLOGY_ANCHORS } from "@/lib/methodology-anchors";
import type { SubtopicCard as SubtopicCardData } from "@/lib/api/home";

export function SelectedResearchCarousel({
  items,
}: {
  items: SubtopicCardData[];
}) {
  return (
    <section className="mt-12">
      <div className="flex items-baseline gap-4">
        <h2 className="text-lg font-semibold">Selected research</h2>
        <a
          href="/browse"
          className="ml-auto text-sm font-medium text-[var(--color-accent-slate)] hover:underline"
        >
          Browse all areas ↓
        </a>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        Eight subtopics with the strongest recent activity at WCM, one per
        parent area, refreshed weekly ·{" "}
        <a
          href={`${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS.selectedResearch}`}
          className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          How this works
        </a>
      </p>
      <div
        className="mt-6 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4"
        style={{ scrollPaddingLeft: "12px" }}
      >
        {items.map((s) => (
          <div
            key={`${s.parentTopicSlug}::${s.subtopicSlug}`}
            className="w-[calc((100%-1*16px)/1.15)] shrink-0 snap-start sm:w-[calc((100%-1*16px)/2.15)] lg:w-[calc((100%-2*16px)/3.15)]"
          >
            <SubtopicCard item={s} />
          </div>
        ))}
      </div>
    </section>
  );
}
