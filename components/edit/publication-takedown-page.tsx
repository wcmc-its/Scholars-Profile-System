/**
 * The publication-takedown page shell (#356 Phase 7 C7, UI-SPEC §
 * `/edit/publication/[pmid]`).
 *
 * Server Component. Wraps the superuser banner + summary card + takedown
 * card in the standard `/edit/*` shell layout.
 */
import { PublicationSummaryCard } from "@/components/edit/publication-summary-card";
import { PublicationTakedownCard } from "@/components/edit/publication-takedown-card";
import { SuperuserBanner } from "@/components/edit/superuser-banner";
import type { PublicationTakedownContext } from "@/lib/api/publication-takedown-context";

export type PublicationTakedownPageProps = {
  ctx: PublicationTakedownContext;
};

export function PublicationTakedownPage({ ctx }: PublicationTakedownPageProps) {
  return (
    <main className="mx-auto w-full max-w-[var(--max-narrow)] px-6 py-10 md:py-12">
      <header className="mb-6">
        <h1 className="page-title">Manage publication</h1>
        <p className="text-muted-foreground text-sm">
          Hide or restore this publication across the site.
        </p>
      </header>
      <SuperuserBanner targetLabel={ctx.publication.title} targetKind="publication" />
      <div className="flex flex-col gap-6">
        <PublicationSummaryCard publication={ctx.publication} authors={ctx.authors} />
        <PublicationTakedownCard
          pmid={ctx.publication.pmid}
          takedown={ctx.takedown}
          derivedDark={ctx.derivedDark}
        />
      </div>
    </main>
  );
}
