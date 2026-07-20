import { AdminSubnav, type AdminSubnavActive } from "@/components/edit/admin-subnav";
import { ConsoleTopBar } from "@/components/edit/console-top-bar";
import { deriveConsoleTabs } from "@/lib/edit/console-tabs";
import type { EditSession } from "@/lib/auth/superuser";

/**
 * The shared chrome for every `/edit` CONSOLE page — the list / queue / dashboard
 * surfaces, NOT the master-detail editor (that keeps `EditShell`). Renders the
 * warm page background, a skip link, the shared `ConsoleTopBar`, the role-gated
 * `AdminSubnav` (props from `deriveConsoleTabs`), and the standard max-width
 * `<main>`. Children own their content — the `<h1>`, the prose, the tables/cards
 * and their fills — so this owns ONLY the chrome the ~14 hand-rolled copies kept
 * getting wrong (`docs/2026-07-20-console-shell-migration-plan.md`).
 *
 * The account menu is NOT here: it lives in the `AdminSubnav` strip
 * (`AccountMenu context="console"`, self-fetching), which is why no actor scholar
 * row threads through the page — unchanged from before.
 */
export function ConsoleShell({
  active,
  session,
  pendingSlugRequests,
  pendingHonors,
  children,
}: {
  active: AdminSubnavActive;
  session: EditSession;
  /** DB counts — a read per request, so the page resolves them, not this shell. */
  pendingSlugRequests: number | null;
  pendingHonors: number | null;
  children: React.ReactNode;
}) {
  const tabs = deriveConsoleTabs(session);
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
        {...tabs}
      />
      <main id="console-main" tabIndex={-1} className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        {children}
      </main>
    </div>
  );
}
