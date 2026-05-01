/**
 * RANKING-02 — Topic Recent highlights.
 *
 * Server Component. Renders a section heading + caveat line ("Three
 * publications surfaced by ReCiterAI · how this works") + a vertical list of
 * 3 paper cards. Methodology link uses the constant from
 * lib/methodology-anchors.ts (Pitfall 6 in 02-RESEARCH.md).
 *
 * Visual contract: 02-UI-SPEC.md §"/topics/{slug} — Recent highlights" — caveat
 * line copy is verbatim from design-spec-v1.7.1 §538.
 *
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
    <section className="mt-12">
      <h2 className="text-lg font-semibold">Recent highlights</h2>
      <p className="mt-1 text-sm italic text-muted-foreground">
        Three publications surfaced by ReCiterAI ·{" "}
        <a
          href={`${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS.recentHighlights}`}
          className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          how this works
        </a>
      </p>
      <ul className="mt-6 flex flex-col gap-6">
        {papers.map((p) => (
          <li key={p.pmid}>
            <RecentHighlightCard paper={p} />
          </li>
        ))}
      </ul>
    </section>
  );
}
