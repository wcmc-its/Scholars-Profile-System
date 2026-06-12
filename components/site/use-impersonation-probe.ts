"use client";

import { useEffect, useState } from "react";

import type { ConsoleLink } from "@/lib/auth/console-links";

/**
 * Shared client hook for the impersonation state carried by the
 * `/api/auth/session` probe (#637 §6/§7, T6). The amber banner
 * (`impersonation-banner.tsx`) and the switcher entry
 * (`impersonation-switcher.tsx`) both render off this state, so the fetch lives
 * here once.
 *
 * **Why client-probed (T6).** The banner must render on every surface,
 * including CloudFront-cached public pages whose Cookie header is stripped at
 * the edge (cdk/lib/edge-stack.ts). A server-rendered banner would therefore
 * vanish on exactly the cached pages a superuser is most likely to be QA-ing.
 * `/api/auth/session` is on the cookie-forwarding `/api/auth/*` behavior, so a
 * client fetch sees the real session. The probe returns `impersonating: null`
 * and `canImpersonate: false` whenever the feature flag is off, a stale overlay
 * is past its TTL, or the viewer is not a superuser — so a dark deployment
 * renders neither the banner nor the switcher entry without any flag check on
 * the client.
 *
 * The hook returns `null` until the first probe resolves (initial render shows
 * nothing — no banner flash, no switcher entry), then the parsed payload.
 */

/** The signed-in scholar's public slug + display name (the real human). */
export type ProbeScholar = { slug: string; preferredName: string };

/** The live "view as" overlay's target, mirrored from the probe payload (§7). */
export type ProbeImpersonating = {
  targetCwid: string;
  targetName: string;
  role: "owner" | "curator" | "scholar";
  /** The administered unit's kind, or `null` for a plain scholar. */
  unitKind: "department" | "division" | "center" | null;
  unit: string | null;
  startedAt: number;
};

/** The shape `/api/auth/session` returns once impersonation is wired (#637 §7). */
export type ImpersonationProbe = {
  authenticated: boolean;
  scholar: ProbeScholar | null;
  impersonating: ProbeImpersonating | null;
  canImpersonate: boolean;
  /** The role-aware `/edit` console entry points the viewer may open, computed
   *  server-side (`lib/auth/console-links.ts`). Each renders as a row in the
   *  account-menu's "Manage" section. `[]` (the default) renders no section —
   *  a plain scholar, or a probe error. Replaces the old superuser-only
   *  `canBrowseProfiles` flag, so a non-superuser steward / unit admin gets an
   *  entry point too. */
  consoleLinks: ConsoleLink[];
};

/**
 * Probe `/api/auth/session` once. Returns `null` while in flight and on any
 * network error (treat as "no impersonation state" — fail closed to a quiet UI).
 * Never throws.
 *
 * `enabled` (default `true`) gates whether the probe fires. The always-mounted
 * banner leaves it `true` so it can render on any surface; the account-menu
 * defers the probe until its popover is actually opened, passing
 * `enabled={open}` — so a signed-in header render fires no `/api/auth/session`
 * request until the menu is used (the cookie-forwarding probe is the header's
 * concern, not this one, per `header-auth-slot.tsx`). When `enabled` is false
 * the hook is inert and returns `null`.
 */
export function useImpersonationProbe(enabled = true): ImpersonationProbe | null {
  const [probe, setProbe] = useState<ImpersonationProbe | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // `fetch` may be absent or a non-thenable stub in some environments; guard
    // the `.then` chain so a missing/garbage return value fails closed to a
    // quiet UI rather than throwing on `undefined.then`.
    const pending = fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
    Promise.resolve(pending)
      .then((r) => (r && r.ok ? (r.json() as Promise<Partial<ImpersonationProbe>>) : null))
      .then((data) => {
        if (!active || !data) return;
        setProbe({
          authenticated: data.authenticated ?? false,
          scholar: data.scholar ?? null,
          impersonating: data.impersonating ?? null,
          canImpersonate: data.canImpersonate ?? false,
          consoleLinks: data.consoleLinks ?? [],
        });
      })
      .catch(() => {
        /* leave `null` — the banner and switcher stay hidden */
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  return probe;
}
