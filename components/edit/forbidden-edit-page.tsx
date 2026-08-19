/**
 * The /edit/* 403 page (#356 Phase 7 C5, UI-SPEC § States and edge cases row 2,
 * Phase 7 plan §6).
 *
 * Rendered when an authenticated user requests an `/edit/*` URL they lack
 * permission for. Originally worded for its first two callers only
 * (`/edit/scholar/[other-cwid]`, `/edit/publication/[pmid]` — "edit this
 * profile" / "edit another scholar's profile"), but `ForbiddenEditPage` is the
 * shared 403 for the ~20 `ConsoleShell`-wrapped list/queue/dashboard pages too
 * (`/edit/scholars`, `/edit/usage`, `/edit/find-researchers`, …), most of which
 * aren't about editing any specific profile at all — a `development`-role
 * viewer denied `/edit/scholars` was never trying to "edit another scholar's
 * profile", they were trying to browse a roster their role doesn't cover. The
 * "scholar" variant's copy (2026-08-19) is now generic enough to be true for
 * both: it names no specific action and no specific role. The wire status is
 * the route handler's responsibility — App Router has no `forbidden()`
 * primitive in Next 15.5, so the page response remains HTTP 200 in v1.
 *
 * Server component (no interactivity, no state).
 */
import Link from "next/link";

import { GLOBAL_ROLE_HOME } from "@/lib/auth/global-roles";

/** The handful of `EditSession` fields this page needs to link somewhere more
 *  useful than a bare `/edit` — a structural subset (not the imported type
 *  itself) so a test can pass a plain object without constructing a whole
 *  `EditSession`. */
type OwnHomeSession = {
  isCvGenerator?: boolean;
  isHonorsCurator?: boolean;
  isDataSharingViewer?: boolean;
  isDeveloper?: boolean;
};

/**
 * Where "go to your own console" should actually point. For a superuser /
 * comms_steward / unit admin / plain scholar, `/edit` is already correct — the
 * first two get the full `AdminSubnav` right above this page (`ConsoleShell`
 * always renders it), and the rest land on their own profile. But the four
 * global LDAP-group roles (`cv_generator`/`honors_curator`/`data_sharing_viewer`/
 * `development`) have no self-profile, so `/edit` for them is a SECOND redirect
 * hop (`app/edit/page.tsx`'s own `resolveGlobalRole` fallthrough) instead of
 * the one destination they actually have — checked here first (same priority
 * order as `resolveGlobalRole`) so the link goes straight there. `session`
 * omitted (the two individual-record editor pages that still use the bare
 * `ConsoleTopBar`, `/edit/scholar/[cwid]` and `/edit/publication/[pmid]`, have
 * no session at this branch — `resolveScholarEditAccess`'s `"forbidden"` result
 * carries none) falls back to the generic `/edit` link, unchanged.
 */
function ownDestination(session?: OwnHomeSession): { href: string; label: string } {
  if (session?.isCvGenerator) return GLOBAL_ROLE_HOME.cv_generator;
  if (session?.isHonorsCurator) return GLOBAL_ROLE_HOME.honors_curator;
  if (session?.isDataSharingViewer) return GLOBAL_ROLE_HOME.data_sharing_viewer;
  if (session?.isDeveloper) return GLOBAL_ROLE_HOME.development;
  return { href: "/edit", label: "your own console" };
}

export type ForbiddenEditPageProps = {
  /**
   * For diagnostics only — currently used as a `data-target-cwid` attribute so
   * a test or screen-recording can confirm which cwid the user was denied for.
   * The visible copy never names the target.
   */
  targetCwid?: string;
  /**
   * Which surface the denial is for. `"scholar"` (default) is the generic
   * console 403 — every list/queue/dashboard/editor page except unit pages;
   * `"unit"` is the #540 unit-curation denial (`/edit/{department,division,
   * center}/[code]`), which keeps its own more specific copy since it always
   * has an Owner/Curator/administrator answer. Diagnostics only — the visible
   * copy never names the unit.
   */
  variant?: "scholar" | "unit";
  /** Unit denials: the unit code, surfaced as `data-target-entity` for tests. */
  targetEntity?: string;
  /** The denied viewer's resolved session, when the caller has one on hand —
   *  every `ConsoleShell`-wrapped page does. Powers `ownDestination` above;
   *  omitted, the fallback link stays the generic `/edit`. `"unit"` variant
   *  ignores this (its own copy already has a definite answer). */
  session?: OwnHomeSession;
};

export function ForbiddenEditPage({
  targetCwid,
  variant = "scholar",
  targetEntity,
  session,
}: ForbiddenEditPageProps) {
  if (variant === "unit") {
    return (
      <main
        className="bg-apollo-page min-h-screen mx-auto w-full max-w-[var(--max-narrow)] px-6 py-16 text-center"
        data-slot="forbidden-edit-page"
        data-variant="unit"
        data-target-entity={targetEntity ?? ""}
      >
        <h1 className="page-title font-bold">You don&apos;t have permission to edit this unit.</h1>
        <p className="text-muted-foreground mt-4">
          Only an Owner, Curator, or administrator can edit this unit.
        </p>
        <p className="mt-8">
          <Link href="/" className="text-apollo-slate hover:underline">
            Return to Scholars
          </Link>
        </p>
      </main>
    );
  }

  const home = ownDestination(session);
  return (
    <main
      className="bg-apollo-page min-h-screen mx-auto w-full max-w-[var(--max-narrow)] px-6 py-16 text-center"
      data-slot="forbidden-edit-page"
      data-target-cwid={targetCwid ?? ""}
    >
      <h1 className="page-title font-bold">You don&apos;t have access to this page.</h1>
      <p className="text-muted-foreground mt-4">Your account&apos;s role doesn&apos;t include it.</p>
      <p className="mt-8">
        <Link href={home.href} className="text-apollo-slate hover:underline">
          Go to {home.label}
        </Link>
      </p>
    </main>
  );
}
