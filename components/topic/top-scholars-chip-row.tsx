/**
 * RANKING-03 — Top scholars chip row.
 *
 * Server Component. Renders a section heading + methodology footnote +
 * horizontal row of 7 chips. Methodology link uses the constant from
 * lib/methodology-anchors.ts so this component and the methodology page
 * cannot drift (Pitfall 6 in 02-RESEARCH.md).
 *
 * Visual contract: 02-UI-SPEC.md §"/topics/{slug} — Top scholars chip row".
 *   - Section heading 18px / weight 600 ("text-lg font-semibold").
 *   - Methodology footnote 13px italic muted, link in Slate accent.
 *   - Horizontal row, gap-2, py-2 (44px tap-target on mobile).
 *
 * Data contract: TopScholarChipData[] from lib/api/topics.ts.
 */
import { TopScholarChip } from "./top-scholar-chip";
import {
  METHODOLOGY_BASE,
  METHODOLOGY_ANCHORS,
} from "@/lib/methodology-anchors";
import type { TopScholarChipData } from "@/lib/api/topics";

export function TopScholarsChipRow({
  scholars,
}: {
  scholars: TopScholarChipData[];
}) {
  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold">Top scholars in this area</h2>
      <p className="mt-1 text-sm italic text-muted-foreground">
        Ranked by ReCiterAI publication impact ·{" "}
        <a
          href={`${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS.topScholars}`}
          className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          How this works
        </a>
      </p>
      <div className="mt-6 flex gap-2 overflow-x-auto py-2">
        {scholars.map((s) => (
          <TopScholarChip key={s.cwid} scholar={s} />
        ))}
      </div>
    </section>
  );
}
