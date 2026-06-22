/**
 * `/edit/find-researchers` — GrantRecs Phase 4, the "Find researchers"
 * reverse-matcher admin surface (`2026-06-20-grantrecs-phase4-design-plan.md`).
 *
 * Audience: a superuser OR a `development`-role member (`isDeveloper`). The role
 * is the dark-ship lever — the page + its data route are reachable by superusers
 * immediately, and by the development-role allowlist once `DEVELOPMENT_ENABLED`
 * is flipped on per env. A non-authorized viewer gets the Forbidden page.
 *
 * Authorization is re-checked here on every GET, never cached; the page mirrors
 * the gate the data route (`/api/opportunities/[id]/researchers`) enforces, so
 * the route remains the real authorization boundary. `force-dynamic` + `noindex`,
 * mirroring the other `/edit/*` pages. This is a standalone, single-tool surface
 * (no AdminSubnav): a pure development-role user is not a full console citizen —
 * their entry point is the account-menu dropdown.
 */
import { redirect } from "next/navigation";

import { FindResearchers } from "@/components/edit/find-researchers";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { isAccountConsoleNavRestructureEnabled } from "@/lib/auth/account-console-nav";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { logEditDenial } from "@/lib/edit/authz";

export const dynamic = "force-dynamic";

// The tab title tracks the account-menu label (account-dropdown-nav handoff,
// Workstream B): "Funding matcher" when the unified-nav flag is on, the legacy
// "Find researchers" when off — so the dropdown and this page never disagree.
export function generateMetadata() {
  const toolName = isAccountConsoleNavRestructureEnabled() ? "Funding matcher" : "Find researchers";
  return {
    title: `${toolName} — Scholars Profile Console`,
    robots: { index: false, follow: false },
  };
}

export default async function FindResearchersPage() {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/find-researchers");
  }
  // Superuser OR development role — the same verdict the data route reads.
  if (!(session.isSuperuser || session.isDeveloper)) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "find-researchers",
      path: "/edit/find-researchers",
      reason: "not_developer_get",
    });
    return <ForbiddenEditPage />;
  }

  return (
    <div className="min-h-screen bg-[var(--background)]" data-slot="find-researchers-page">
      <header className="bg-apollo-bar text-white">
        <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center gap-3 px-6">
          <span
            className="bg-apollo-maroon flex size-7 items-center justify-center rounded-sm text-xs font-bold"
            aria-hidden
          >
            WCM
          </span>
          <span className="font-semibold">Scholars Profile Console</span>
        </div>
      </header>

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8">
        <FindResearchers unifiedNav={isAccountConsoleNavRestructureEnabled()} />
      </main>
    </div>
  );
}
