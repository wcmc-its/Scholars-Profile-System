"use client";

/**
 * Sub-tabs on `/edit/grant-matcha` (patterned on the retired
 * `find-researchers-tabs.tsx`; the sunset made this the intake pipeline's only
 * mount):
 *
 *   - **Browse** (default) — `GrantMatchaPanel`, exactly as before: the shared
 *     opportunity table, and the Matcha run once one is picked (`?opp=<id>`).
 *   - **Submissions** — the submit-a-URL intake form + the whole team's queue
 *     history (`OpportunityIntakePanel`). Rendered ONLY while the server passed
 *     `intakeEnabled` (`OPPORTUNITY_URL_INTAKE`); flag off renders the bare
 *     panel with no tab strip — the dark-ship posture.
 *
 * The active tab lives in the URL (`?tab=submissions`), so it is deep-linkable
 * and browser Back returns to the previous tab. One precedence rule on top: a
 * non-empty `?opp=<id>` means the user deep-linked a SELECTED opportunity, so
 * Browse renders regardless of `?tab=` — the officer's pasted-into-Teams link
 * must never land on the intake form. The Submissions href therefore drops
 * `opp` (keeping it would make the tab a no-op under that same rule); the rest
 * of the query is preserved across switches. The page is force-dynamic, so
 * `useSearchParams` needs no Suspense boundary.
 */
import Link from "next/link";
import type { Route } from "next";
import { usePathname, useSearchParams } from "next/navigation";

import { GrantMatchaPanel } from "@/components/edit/grant-matcha-panel";
import { OpportunityIntakePanel } from "@/components/edit/opportunity-intake-panel";

type TabKey = "browse" | "submissions";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "browse", label: "Browse" },
  { key: "submissions", label: "Submissions" },
];

export function GrantMatchaTabs({
  intakeEnabled = false,
  adminEnabled = false,
}: {
  intakeEnabled?: boolean;
  /** `MATCHA_ADMIN` (server-read) — threaded to the Browse panel's suppress/restore controls. */
  adminEnabled?: boolean;
} = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Empty (`?opp=`) is not a selection — mirrors `GrantMatchaPanel`'s own
  // truthiness check on the same param.
  const hasSelection = Boolean(searchParams.get("opp"));
  const active: TabKey =
    !hasSelection && searchParams.get("tab") === "submissions" ? "submissions" : "browse";

  // Flag off → the bare panel, no tab strip — the intake surface is not
  // advertised anywhere it cannot be used.
  if (!intakeEnabled) return <GrantMatchaPanel adminEnabled={adminEnabled} />;

  // Keep the rest of the query when switching tabs; Browse is the default, so
  // its href simply drops the `tab` param. Submissions drops `opp` too — a
  // selection would win over `?tab=` (the precedence rule above), turning the
  // tab into a no-op while an opportunity is drilled in.
  const hrefFor = (tab: TabKey): Route => {
    const params = new URLSearchParams(searchParams);
    if (tab === "submissions") {
      params.set("tab", "submissions");
      params.delete("opp");
    } else {
      params.delete("tab");
    }
    const qs = params.toString();
    return (qs ? `${pathname}?${qs}` : pathname) as Route;
  };

  return (
    <div data-slot="grant-matcha-tabs">
      <div role="tablist" className="mb-5 flex gap-7 border-b border-[var(--color-border)]">
        {TABS.map((t) => {
          const isActive = t.key === active;
          const className = [
            "-mb-px py-2.5 text-sm transition-colors border-b-2",
            isActive
              ? "border-[var(--color-accent-slate)] font-medium text-[var(--color-accent-slate)]"
              : "text-muted-foreground hover:text-foreground border-transparent hover:no-underline",
          ].join(" ");
          return (
            <Link
              key={t.key}
              href={hrefFor(t.key)}
              role="tab"
              aria-selected={isActive}
              className={className}
              data-testid={`grant-matcha-tab-${t.key}`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
      {active === "browse" ? (
        <GrantMatchaPanel adminEnabled={adminEnabled} />
      ) : (
        <OpportunityIntakePanel />
      )}
    </div>
  );
}
