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

let current: Promise<SessionProbeData | null> | null = null;

export function probeSession(): Promise<SessionProbeData | null> {
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
