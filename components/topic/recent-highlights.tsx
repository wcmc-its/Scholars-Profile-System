/**
 * RANKING-02 — Topic Recent highlights.
 *
 * Server Component. 3-column grid with vertical dividers; single
 * baseline-aligned header row (eyebrow left, caveat + methodology link right).
 *
 * Visual contract: 02-UI-SPEC.md §"/topics/{slug} — Recent highlights".
 * Data contract: RecentHighlight[] from lib/api/topics.ts.
 */
import { RecentHighlightCard } from "./recent-highlight-card";
import {
  METHODOLOGY_BASE,
  METHODOLOGY_ANCHORS,
} from "@/lib/methodology-anchors";
import type { RecentHighlight } from "@/lib/api/topics";

export function RecentHighlights({ papers }: { papers: RecentHighlight[] }) {
  return (
    <section className="mb-10">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Recent highlights
        </span>
        <span className="shrink-0 text-xs italic text-muted-foreground">
          Three publications surfaced by ReCiterAI ·{" "}
          <a
            href={`${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS.recentHighlights}`}
            className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
          >
            how this works
          </a>
        </span>
      </div>
      <div className="grid grid-cols-1 divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
        {papers.map((p, i) => (
          <div key={p.pmid} className={i > 0 ? "pt-4 md:pl-6 md:pt-0" : ""}>
            <RecentHighlightCard paper={p} />
          </div>
        ))}
      </div>
    </section>
  );
}
