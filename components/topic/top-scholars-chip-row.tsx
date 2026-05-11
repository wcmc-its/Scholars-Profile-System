/**
 * RANKING-03 — Top scholars chip row.
 *
 * Server Component. Renders an eyebrow + wrap-flow row of up to 7 chips,
 * terminated by a "+ N more scholars →" link when scholarCount exceeds
 * the displayed chip count.
 *
 * Visual contract: 02-UI-SPEC.md §"/topics/{slug} — Top scholars chip row".
 * Data contract: TopScholarChipData[] from lib/api/topics.ts.
 */
import { TopScholarChip } from "./top-scholar-chip";
import {
  METHODOLOGY_BASE,
  METHODOLOGY_ANCHORS,
} from "@/lib/methodology-anchors";
import { SectionInfoButton } from "@/components/shared/section-info-button";
import type { TopScholarChipData } from "@/lib/api/topics";

export function TopScholarsChipRow({
  scholars,
  scholarCount,
  topicSlug,
}: {
  scholars: TopScholarChipData[];
  scholarCount?: number;
  topicSlug?: string;
}) {
  const moreCount = scholarCount !== undefined ? scholarCount - scholars.length : 0;

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Top scholars in this area
          <SectionInfoButton label="Top scholars in this area" anchor="topScholars">
            Full-time faculty ranked by ReCiterAI on their first- or
            senior-author publications in this research area. Curators do not
            handpick this list; the order updates weekly as new work appears.
          </SectionInfoButton>
        </span>
        <span className="text-xs italic text-muted-foreground">
          Ranked by ReCiterAI ·{" "}
          <a
            href={`${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS.topScholars}`}
            className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
          >
            how this works
          </a>
        </span>
      </div>
      <div className="flex flex-wrap gap-2 py-1">
        {scholars.map((s) => (
          <TopScholarChip key={s.cwid} scholar={s} />
        ))}
        {moreCount > 0 && topicSlug && (
          <a
            href={`/topics/${encodeURIComponent(topicSlug)}/scholars`}
            className="flex shrink-0 items-center rounded-full border border-border bg-background px-3 py-1 text-sm text-[var(--color-accent-slate)] transition-colors hover:border-[var(--color-accent-slate)]"
          >
            + {moreCount.toLocaleString()} more scholars →
          </a>
        )}
      </div>
    </div>
  );
}
