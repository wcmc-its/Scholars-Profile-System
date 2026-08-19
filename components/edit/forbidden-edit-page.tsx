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
 * Server component (no interactivity, no state) — except when `ownDestinations`
 * resolves to exactly one place, in which case this redirects there instead of
 * rendering anything (2026-08-19; see that function's doc comment). `redirect()`
 * from a Server Component works no matter how deep it's thrown from in the RSC
 * tree — the same pattern `notFound()` already uses at several nested call
 * sites in this codebase — so this stays a drop-in `<ForbiddenEditPage />` for
 * every caller; no page had to change to opt in.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { GLOBAL_ROLE_HOME } from "@/lib/auth/global-roles";

/** The handful of `EditSession` fields this page needs to link somewhere more
 *  useful than a bare `/edit` — a structural subset (not the imported type
 *  itself) so a test can pass a plain object without constructing a whole
 *  `EditSession`. A real `EditSession` satisfies this structurally, so every
 *  call site passes its existing `session` variable unchanged. */
type OwnHomeSession = {
  isSuperuser?: boolean;
  isCommsSteward?: boolean;
  isCvGenerator?: boolean;
  isHonorsCurator?: boolean;
  isDataSharingViewer?: boolean;
  isDeveloper?: boolean;
};

/** `/edit/scholars`, labeled for someone who can actually WRITE there — as
 *  opposed to `GLOBAL_ROLE_HOME.cv_generator`, the same href for a read-only
 *  visitor. Kept as its own constant so the two never drift apart. */
const PROFILES_LINK = { href: "/edit/scholars", label: "Profiles" };

/**
 * Every destination this session actually has, in priority order — NOT just
 * the first match. A real person can hold more than one of these grants at
 * once (e.g. a `development`-role staffer who is also `honors_curator`), and
 * showing only the first one silently hides the rest.
 *
 * Profiles comes FIRST whenever the viewer can genuinely edit a scholar
 * profile — `isSuperuser` or `isCommsSteward` (a global profile editor per
 * comms-steward-profile-editing-spec.md §4d) — since that is the console's
 * daily-driver surface, the same reasoning `lib/auth/console-links.ts`'s own
 * docblock gives for putting "Profiles" ahead of "Org units" there.
 * `cv_generator`'s read-only variant of the same page is the fallback ONLY
 * when neither broader grant applies, so a superuser who also happens to be
 * `cv_generator` never sees a redundant second "(read-only)" link to the
 * href they already have full access to.
 *
 * (Deliberately NOT keyed on unit-admin/`managesUnits` — that verdict needs
 * its own DB read (`loadManageableUnits`), not a plain `EditSession` field,
 * and a unit owner/curator is already admitted by `/edit/scholars`'s own D5/
 * B3 scope check whenever they hold a grant, so they rarely reach this page's
 * scholar-variant at all. `EditSession`'s existing boolean fields cover every
 * case that's actually been hit.)
 *
 * `session` omitted (the two individual-record editor pages still on the
 * bare `ConsoleTopBar`, `/edit/scholar/[cwid]` and `/edit/publication/[pmid]`
 * — `resolveScholarEditAccess`'s `"forbidden"` result carries no session) or
 * carrying none of these grants falls back to the generic `/edit` link,
 * unchanged.
 *
 * When this resolves to exactly ONE entry, the caller below redirects there
 * immediately instead of showing a page with one link on it — there's no
 * reason to make someone click through an interstitial to the only place
 * they can go. This mirrors `/edit`'s own profile-less fallthrough
 * (`app/edit/page.tsx`), which has always redirected `comms_steward` /
 * `cv_generator` / the other global roles straight through with no
 * interstitial of its own. A page IS still shown when there's more than one
 * destination (can't silently pick for the viewer) or none resolved at all
 * (the generic `/edit` single-entry case still redirects — `/edit` does its
 * own further routing/404ing from there, unchanged from what the link used
 * to point at).
 */
function ownDestinations(session?: OwnHomeSession): ReadonlyArray<{ href: string; label: string }> {
  const links: Array<{ href: string; label: string }> = [];
  if (session?.isSuperuser || session?.isCommsSteward) {
    links.push(PROFILES_LINK);
  } else if (session?.isCvGenerator) {
    links.push(GLOBAL_ROLE_HOME.cv_generator);
  }
  if (session?.isHonorsCurator) links.push(GLOBAL_ROLE_HOME.honors_curator);
  if (session?.isDataSharingViewer) links.push(GLOBAL_ROLE_HOME.data_sharing_viewer);
  if (session?.isDeveloper) links.push(GLOBAL_ROLE_HOME.development);
  return links.length > 0 ? links : [{ href: "/edit", label: "your own console" }];
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
   *  every `ConsoleShell`-wrapped page does. Powers `ownDestinations` above;
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

  const homes = ownDestinations(session);
  // Exactly one place to go — take them there directly (see the doc comment
  // on `ownDestinations` above). `redirect()` throws; nothing below this line
  // runs when it fires.
  if (homes.length === 1) {
    redirect(homes[0].href);
  }
  return (
    <main
      className="bg-apollo-page min-h-screen mx-auto w-full max-w-[var(--max-narrow)] px-6 py-16 text-center"
      data-slot="forbidden-edit-page"
      data-target-cwid={targetCwid ?? ""}
    >
      <h1 className="page-title font-bold">You don&apos;t have access to this page.</h1>
      <p className="text-muted-foreground mt-4">Your account&apos;s role doesn&apos;t include it.</p>
      <p className="mt-8">
        Go to{" "}
        {homes.map((home, i) => (
          <span key={home.href}>
            {i > 0 && " · "}
            <Link href={home.href} className="text-apollo-slate hover:underline">
              {home.label}
            </Link>
          </span>
        ))}
      </p>
    </main>
  );
}
