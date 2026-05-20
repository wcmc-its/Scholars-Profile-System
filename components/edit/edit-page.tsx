/**
 * The shared `/edit/*` page shell (#356 Phase 6 C8 / Phase 7 C5, UI-SPEC §
 * Global layout — the `/edit/*` shell + § `/edit/scholar/[cwid]`).
 *
 * Server Component composing client-island cards inside one centered
 * container. Phase 6 wired the `self` mode (Card 1 Overview, Card 2 Visibility,
 * Card 3 My publications); Phase 7 fills the `'superuser'` branch — read-only
 * Overview, Visibility with required-reason dialog, and the Slug-override
 * card in place of "My publications" (UI-SPEC § /edit/scholar/[cwid]).
 */
import { OverviewCard } from "@/components/edit/overview-card";
import { PublicationsCard } from "@/components/edit/publications-card";
import { SlugCard } from "@/components/edit/slug-card";
import { SuperuserBanner } from "@/components/edit/superuser-banner";
import { VisibilityCard } from "@/components/edit/visibility-card";
import type { EditContext } from "@/lib/api/edit-context";

export type EditPageProps = {
  ctx: EditContext;
  /**
   * `'self'` (default) — the Phase 6 surface. `'superuser'` — the read-only
   * Overview + required-reason Visibility + Slug-override surface; renders the
   * superuser banner above the cards and adjusts the page title.
   */
  mode?: "self" | "superuser";
};

export function EditPage({ ctx, mode = "self" }: EditPageProps) {
  const isSuperuser = mode === "superuser";
  return (
    <main className="mx-auto w-full max-w-[var(--max-narrow)] px-6 py-10 md:py-12">
      <header className="mb-6">
        <h1 className="page-title">
          {isSuperuser ? `Edit profile — ${ctx.scholar.preferredName}` : "Edit my profile"}
        </h1>
        <p className="text-muted-foreground text-sm">
          {isSuperuser
            ? "Changes appear on this scholar's public profile."
            : "Changes appear on your public profile."}
        </p>
      </header>
      {isSuperuser && <SuperuserBanner targetLabel={ctx.scholar.preferredName} />}
      <div className="flex flex-col gap-6">
        <OverviewCard
          cwid={ctx.scholar.cwid}
          initialHtml={ctx.scholar.overview}
          readOnly={isSuperuser}
        />
        <VisibilityCard
          cwid={ctx.scholar.cwid}
          suppression={ctx.scholar.suppression}
          scholarName={ctx.scholar.preferredName}
          mode={mode}
        />
        {isSuperuser ? (
          <SlugCard
            cwid={ctx.scholar.cwid}
            liveSlug={ctx.scholar.slug}
            initialOverride={ctx.scholar.slugOverride}
          />
        ) : (
          <PublicationsCard cwid={ctx.scholar.cwid} publications={ctx.publications} />
        )}
      </div>
    </main>
  );
}
