/**
 * Home-page Recent contributions section. Server Component renders a section
 * heading, methodology link, and responsive grid of RecentContributionCard.
 *
 * Sparse-state hide is the caller's responsibility — pass null/empty array
 * upstream when below floor (D-12); this component renders whatever's given.
 *
 * Layout per UI-SPEC sketch 003 Variant D + responsive breakpoints:
 *   - Desktop ≥1024px: 3 columns
 *   - Tablet 640–1023px: 2 columns
 *   - Mobile <640px: 1 column
 */
import { RecentContributionCard } from "./recent-contribution-card";
import { METHODOLOGY_BASE, METHODOLOGY_ANCHORS } from "@/lib/methodology-anchors";
import { SectionInfoButton } from "@/components/shared/section-info-button";
import type { RecentContribution } from "@/lib/api/home";

export function RecentContributionsGrid({
  items,
}: {
  items: RecentContribution[];
}) {
  return (
    <section className="mt-12">
      <h2 className="inline-flex items-center gap-2 text-lg font-semibold">
        Recent contributions
        <SectionInfoButton label="Recent contributions" anchor="recentContributions">
          A rotating snapshot of recent first- or senior-author papers by WCM
          faculty, postdocs, fellows, and doctoral students. ReCiterAI ranks
          publications from PubMed metadata; we do not generate the papers or
          rewrite citations.
        </SectionInfoButton>
      </h2>
      <p className="text-muted-foreground mt-1 text-sm italic">
        Faculty contributions ranked by ReCiterAI ·{" "}
        <a
          href={`${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS.recentContributions}`}
          className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          How this works
        </a>
      </p>
      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((c) => (
          <RecentContributionCard key={c.paper.pmid} item={c} />
        ))}
      </div>
    </section>
  );
}
