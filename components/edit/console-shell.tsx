import { AdminSubnav, type AdminSubnavActive } from "@/components/edit/admin-subnav";
import { ConsoleTopBar } from "@/components/edit/console-top-bar";
import { db } from "@/lib/db";
import { loadConsoleTabs } from "@/lib/edit/console-tabs.server";
import type { EditSession } from "@/lib/auth/superuser";

/**
 * The shared chrome for every `/edit` CONSOLE page — the list / queue / dashboard
 * surfaces, NOT the master-detail editor (that keeps `EditShell`). Renders the
 * warm page background, a skip link, the shared `ConsoleTopBar`, the role-gated
 * `AdminSubnav`, and the standard max-width `<main>`. Children own their
 * content — the `<h1>`, the prose, the tables/cards and their fills — so this
 * owns ONLY the chrome the ~14 hand-rolled copies kept getting wrong
 * (`docs/2026-07-20-console-shell-migration-plan.md`).
 *
 * `loadConsoleTabs` migration (`docs/edit-console-ia-spec.md` Part B §2,
 * `2026-08-14-edit-console-ia-handoff.md` decision 3) — this used to call
 * `deriveConsoleTabs(session)` (session-only) and then merge in per-page
 * grant-derived overrides (`profilesTab`/`dataQualityTab`/`administratorsTab`/
 * `usageTab`), three different ways (OR / replace / no-baseline-at-all). That
 * three-layer merge is exactly how Gaps 1/1b/2/3/4/4b happened — four
 * different pages violated the same "OR your own grant signal onto the
 * baseline" contract four different ways. `loadConsoleTabs` computes the
 * FULL, correct, grant-inclusive answer for every tab from `session` alone
 * (it runs the same four grant reads internally, `cache()`'d per request) —
 * so there is no baseline left to override. `unitsTab`/`reportsTab` remain as
 * pure OR-in escape hatches, not because they're grant-derived overrides (the
 * loader already gets those right) but because a handful of pages want to
 * force their OWN tab on while a viewer is literally standing on it even
 * where the page's own authz is broader than the tab predicate
 * (`/edit/units` has no unit-admin gate of its own; the six `/edit/reports/*`
 * pages force `reportsTab` unconditionally, already audited as safe —
 * `docs/edit-console-ia-spec.md` Part B3). An OR-only escape hatch can only
 * ADD visibility, so it can't reintroduce a Gap-3/4b-shaped bug (I3).
 *
 * The account menu is NOT here: it lives in the `AdminSubnav` strip
 * (`AccountMenu context="console"`, self-fetching), which is why no actor scholar
 * row threads through the page — unchanged from before.
 */
export async function ConsoleShell({
  active,
  session,
  pendingSlugRequests,
  pendingHonors,
  unitsTab,
  reportsTab,
  children,
}: {
  active: AdminSubnavActive;
  session: EditSession;
  /** DB counts — a read per request, so the page resolves them, not this shell. */
  pendingSlugRequests: number | null;
  pendingHonors: number | null;
  /** OR-in escape hatch for `/edit/units`, which has no unit-admin gate of its
   *  own (any signed-in viewer can land there) — see the module doc comment. */
  unitsTab?: boolean;
  /** OR-in escape hatch for the `/edit/reports/*` family, which forces the tab
   *  on unconditionally for whoever's already standing on one of those pages
   *  (Part B3 audited this as safe — every page's own authz already implies
   *  the tab would show). */
  reportsTab?: boolean;
  children: React.ReactNode;
}) {
  const tabs = await loadConsoleTabs(session, db.read);
  return (
    <div className="bg-apollo-page min-h-screen">
      {/* Skip link — first focusable element, jumps past the tab strip to the page. */}
      <a
        href="#console-main"
        className="bg-apollo-maroon text-apollo-maroon-foreground sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <ConsoleTopBar variant="console" />
      <AdminSubnav
        active={active}
        pendingSlugRequests={pendingSlugRequests}
        pendingHonors={pendingHonors}
        superuserSurfaces={session.isSuperuser}
        profilesTab={tabs.profiles}
        unitsTab={tabs.units || unitsTab}
        administratorsTab={tabs.administrators ? 0 : null}
        methodsTab={tabs.methods ? 0 : null}
        dataSharingTab={tabs.dataSharing ? 0 : null}
        reportsTab={tabs.reports || reportsTab}
        newsTab={tabs.news}
        usageTab={tabs.usage}
        viewerIsDeveloper={session.isDeveloper === true}
      />
      <main id="console-main" tabIndex={-1} className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        {children}
      </main>
    </div>
  );
}
