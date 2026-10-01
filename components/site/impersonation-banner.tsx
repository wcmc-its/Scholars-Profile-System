"use client";

import { useEffect, useState } from "react";
import { EyeIcon } from "lucide-react";

import { useImpersonationProbe } from "@/components/site/use-impersonation-probe";

/**
 * The "View as" impersonation banner (#637, impersonation-spec.md §6/§8, R7/T6).
 *
 * A one-line **dark warm-ink** bar (`apollo-bar`, #2a2421; Front page tweaks
 * mockup, 2026-09-30 — it was a three-line amber bar). Neither Cornell red
 * (#B31B1B, the header chrome) nor Apollo maroon (#7d1c1c, the /edit editor);
 * a hairline separates it from the same-colored /edit console bar below it.
 * Full-width, sticky to the very top, and it **pushes content down**
 * (it is a flow element, not an overlay) so it can never be missed or hidden
 * behind the header. Non-dismissible (R7) — the only exit is "Return to my view"
 * or auto-expiry.
 *
 * **Client-probed (T6), never server-only.** Mounted in the root layout above
 * the header, it reads its state from `/api/auth/session` via
 * `useImpersonationProbe`. A server-rendered banner would vanish on
 * CloudFront-cached public pages whose Cookie header is stripped at the edge —
 * exactly the pages a superuser QA's. When the probe reports no live overlay
 * (none, past-TTL, or feature flag off) this renders nothing.
 *
 * Editing is live while impersonating (edits authorize as the target but are
 * attributed to the real actor + `impersonated_cwid`, R3), so the copy states
 * plainly that edits are *logged to you* — the confused-deputy mitigation (T6)
 * made explicit in words, not just color. The header's account trigger shows
 * the target's name while this bar is up (`account-menu.tsx`).
 *
 * `role="status"` + `aria-live="polite"` announces the state to assistive tech
 * on entry; the "Return to my view" exit is an always-present, keyboard-
 * focusable button. The countdown mirrors the server's read-time TTL
 * (`NEXT_PUBLIC_IMPERSONATION_TTL_SECONDS`, default 1800) measured from the
 * overlay's `startedAt`; it is advisory — the authoritative expiry is the server
 * seam (`lib/auth/effective-identity.ts`).
 *
 * The target's own destination(s) (`ROLE_LINKS` below) render in the account
 * menu, not here. Without them, a superuser previewing a narrower role has no
 * way to know where that role's own console page lives — the four global roles
 * aren't even searchable in the switcher, and reloading on whatever `/edit/*`
 * page they started from just as likely 403s.
 */

export type SubjectRole =
  | "owner"
  | "curator"
  | "scholar"
  | "comms_steward"
  | "cv_generator"
  | "honors_curator"
  | "data_sharing_viewer"
  | "development";

const ROLE_LABEL: Record<SubjectRole, string> = {
  owner: "Owner",
  curator: "Curator",
  scholar: "Scholar",
  comms_steward: "Communications Steward",
  cv_generator: "CV Generator",
  honors_curator: "Honors Curator",
  data_sharing_viewer: "Data Sharing Viewer",
  development: "Development",
};

/**
 * Where the target's own role actually goes (2026-08-19 — a superuser
 * impersonating a search-blind global role, e.g. `development`, otherwise has
 * no way to find the one page it unlocks: the switcher can't enumerate them
 * (`impersonation-switcher.tsx`'s exact-CWID-fallback docblock), and reloading
 * on whatever `/edit/*` page the superuser started from just as likely lands
 * on `ForbiddenEditPage` for the target's real, narrower permissions). Static,
 * not probe-fetched — every one of these roles has a FIXED destination (each
 * global role's own doc comment calls out its single entry point; `owner`/
 * `curator` get the same two links `lib/auth/console-links.ts` gives a
 * non-superuser unit admin), so no extra round trip is needed. `Record<SubjectRole,
 * …>` mirrors `ROLE_LABEL` above — a role added to the union fails to compile
 * here until it's placed.
 */
export const ROLE_LINKS: Record<SubjectRole, ReadonlyArray<{ label: string; href: string }>> = {
  scholar: [{ label: "Their profile", href: "/edit" }],
  owner: [
    { label: "Profiles", href: "/edit/profiles" },
    { label: "Org units", href: "/edit/units" },
  ],
  curator: [
    { label: "Profiles", href: "/edit/profiles" },
    { label: "Org units", href: "/edit/units" },
  ],
  // Mirrors `buildConsoleLinks`' steward collapse (#2521): one "Admin console"
  // door; the steward's own AdminSubnav fans out to Method families and the
  // rest from there (incl. cores + access management since #2522).
  comms_steward: [{ label: "Admin console", href: "/edit/profiles" }],
  cv_generator: [{ label: "Profiles (read-only)", href: "/edit/profiles" }],
  honors_curator: [{ label: "Honors queue", href: "/edit/honors-queue" }],
  data_sharing_viewer: [{ label: "Data sharing", href: "/edit/data-sharing" }],
  development: [{ label: "Grant Matcha", href: "/edit/grant-matcha" }],
};

/** Compact unit-kind suffix for the banner's subject line. */
const KIND_SHORT: Record<"department" | "division" | "center" | "core" | "institution", string> = {
  department: "Dept",
  division: "Div",
  center: "Center",
  core: "Core",
  institution: "Institution",
};

/**
 * The subject descriptor after the name: a plain `Scholar`, or
 * `Owner · {unit} ({Dept|Div|Center|Core})` for a unit owner/curator (ADR-005
 * Amendment 1 role × unit-kind, #540).
 */
export function subjectDescriptor(im: {
  role: SubjectRole;
  unitKind: "department" | "division" | "center" | "core" | "institution" | null;
  unit: string | null;
}): string {
  // Only owner/curator carry an administered unit — every other role (a plain
  // scholar, comms_steward, or any global LDAP-group role) stands alone. A
  // positive check (owner/curator) rather than an enumeration of the unit-less
  // roles, so a future role added to `SubjectRole` needs no edit here.
  if (im.role !== "owner" && im.role !== "curator") return ROLE_LABEL[im.role];
  const unit = im.unit ? ` · ${im.unit}` : "";
  const kind = im.unitKind ? ` (${KIND_SHORT[im.unitKind]})` : "";
  return `${ROLE_LABEL[im.role]}${unit}${kind}`;
}

/** Client mirror of the server read-time TTL; falls back to 30 min. */
export const TTL_SECONDS = Number(process.env.NEXT_PUBLIC_IMPERSONATION_TTL_SECONDS ?? 1800);

/** Format whole seconds remaining as `m:ss` (clamped at 0). */
function formatRemaining(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ImpersonationBanner() {
  const probe = useImpersonationProbe();
  const impersonating = probe?.impersonating ?? null;

  // Live countdown to the overlay's read-time expiry. `nowSeconds` ticks once a
  // second while a banner is shown; the effect is a no-op (and the interval is
  // never set) when there is no overlay, so a non-impersonating page pays
  // nothing.
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!impersonating) return;
    setNowSeconds(Math.floor(Date.now() / 1000));
    const id = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [impersonating]);

  const [returning, setReturning] = useState(false);

  if (!impersonating) return null;

  const realName = probe?.scholar?.preferredName ?? probe?.displayName ?? null;
  const expiresAt = impersonating.startedAt + TTL_SECONDS;
  const remaining = formatRemaining(expiresAt - nowSeconds);

  async function returnToMyView() {
    setReturning(true);
    try {
      await fetch("/api/impersonation", {
        method: "DELETE",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
      });
    } catch {
      /* best-effort — reload regardless so the cleared cookie takes effect */
    }
    window.location.reload();
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="impersonation-banner"
      data-testid="impersonation-banner"
      className="bg-apollo-bar sticky top-0 z-[60] w-full border-b border-white/20 text-white"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-1 px-6 py-2.5 text-sm">
        <EyeIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          Viewing as <strong className="font-semibold">{impersonating.targetName}</strong>
          {" · "}
          {subjectDescriptor(impersonating)}
        </span>
        <span className="text-[#dbd3cd]">Edits logged to {realName ?? "you"}</span>
        <span
          className="ml-auto whitespace-nowrap text-[#dbd3cd] tabular-nums"
          aria-label={`Auto-expires in ${remaining}`}
          data-testid="impersonation-countdown"
        >
          {remaining} left
        </span>
        <button
          type="button"
          onClick={returnToMyView}
          disabled={returning}
          data-testid="impersonation-return"
          className="inline-flex items-center rounded-md bg-white px-3 py-1 font-medium whitespace-nowrap text-apollo-bar transition-colors hover:bg-[#f2efeb] focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-apollo-bar disabled:opacity-60"
        >
          {returning ? "Returning…" : "Return to my view"}
        </button>
      </div>
    </div>
  );
}
