import type { ImpersonationProbe } from "@/components/site/use-impersonation-probe";

/**
 * The client's one `/api/auth/session` probe per page load.
 *
 * Every client island that needs the viewer's auth state (`HeaderAuthSlot`,
 * `useImpersonationProbe` -> banner / account menu / console sheet,
 * `EditMyProfileButton`, `EditUnitLink`) used to fetch it on its own, so one
 * public page view made two or three identical uncached origin requests. They
 * now share this module-scoped promise: the first caller fetches, the rest
 * reuse the in-flight or settled answer. It lives as long as the document, so a
 * soft navigation reuses it and a hard navigation or reload starts fresh.
 *
 * A failed probe (network error, non-2xx) is not kept: the next caller
 * retries, so one transient error cannot pin a signed-in viewer to "Sign in"
 * for the rest of the page load.
 *
 * Resolves to the route's JSON, or `null` on failure. Never rejects.
 */
export type SessionProbeData = Partial<ImpersonationProbe> & {
  canAccessFundingMatcher?: boolean;
};

/** What `GET /api/auth/session` answers a signed-out visitor, field for field. */
export const SIGNED_OUT: SessionProbeData = {
  authenticated: false,
  scholar: null,
  displayName: null,
  impersonating: null,
  canImpersonate: false,
  canAccessFundingMatcher: false,
  consoleLinks: [],
};

/**
 * The signed-in hint's names, as `signedInHintName` in lib/auth/session.ts
 * writes them (not imported: it would pull iron-session into the client
 * bundle; signed-in-hint.test.ts pins the two together). `__Host-` in deployed
 * envs, bare on local http.
 */
export const SIGNED_IN_HINT_NAMES = ["__Host-sps_signed_in", "sps_signed_in"];

/**
 * Whether the browser holds the signed-in hint. Every session-cookie write sets
 * it with the same lifetime and every clear clears it, so its absence means no
 * session: the probe can be skipped. Its presence proves nothing; the probe
 * still decides.
 */
function hasSignedInHint(): boolean {
  if (typeof document === "undefined") return true;
  return document.cookie.split(";").some((pair) => {
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    return eq > 0 && SIGNED_IN_HINT_NAMES.includes(name) && pair.slice(eq + 1).trim() !== "";
  });
}

let current: Promise<SessionProbeData | null> | null = null;

export function probeSession(): Promise<SessionProbeData | null> {
  // No hint: certainly signed out, so answer as the route would without asking.
  // This is what spares the origin the anonymous probe on every public page.
  if (!hasSignedInHint()) return Promise.resolve(SIGNED_OUT);
  if (current) return current;
  // The executor runs synchronously, so `fetch` fires now; a missing `fetch`
  // or a synchronous throw becomes a rejection, caught below like any failure.
  const pending: Promise<SessionProbeData | null> = new Promise<Response | undefined>((resolve) =>
    resolve(fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" })),
  )
    .then((r) => (r && r.ok ? (r.json() as Promise<SessionProbeData>) : null))
    .catch(() => null)
    .then((data) => {
      if (!data && current === pending) current = null;
      return data ?? null;
    });
  current = pending;
  return pending;
}

/**
 * Drop the cached probe so the next `probeSession()` fetches again. Call it
 * beside any in-page change to the session (impersonation start/stop), before
 * the reload that re-renders the page from the new state.
 */
export function invalidateSessionProbe(): void {
  current = null;
}
