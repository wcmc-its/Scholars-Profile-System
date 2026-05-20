/**
 * The shared `/edit/*` page shell (#356 Phase 6 C8, UI-SPEC § Global layout —
 * the `/edit/*` shell).
 *
 * Server Component composing three client-island cards inside one centered
 * container. Phase 6 wires the `self` mode (the three cards Card 1–3 in
 * UI-SPEC); Phase 7 will add the `superuser` branch — the `mode` prop is
 * declared and threaded now so the Phase-7 signature change is a fill-in,
 * not a refactor.
 */
import { OverviewCard } from "@/components/edit/overview-card";
import { PublicationsCard } from "@/components/edit/publications-card";
import { VisibilityCard } from "@/components/edit/visibility-card";
import type { EditContext } from "@/lib/api/edit-context";

export type EditPageProps = {
  ctx: EditContext;
  /** Reserved for Phase 7; defaulted to `'self'` until the superuser surface lands. */
  mode?: "self" | "superuser";
};

export function EditPage({ ctx }: EditPageProps) {
  return (
    <main className="mx-auto w-full max-w-[var(--max-narrow)] px-6 py-10 md:py-12">
      <header className="mb-6">
        <h1 className="page-title">Edit my profile</h1>
        <p className="text-muted-foreground text-sm">
          Changes appear on your public profile.
        </p>
      </header>
      <div className="flex flex-col gap-6">
        <OverviewCard cwid={ctx.scholar.cwid} initialHtml={ctx.scholar.overview} />
        <VisibilityCard cwid={ctx.scholar.cwid} suppression={ctx.scholar.suppression} />
        <PublicationsCard cwid={ctx.scholar.cwid} publications={ctx.publications} />
      </div>
    </main>
  );
}
