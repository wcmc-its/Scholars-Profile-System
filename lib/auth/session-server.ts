/**
 * B01 — Server Component / Route Handler session access (issue #100).
 *
 * `getSession()` reads the session cookie via `next/headers`. It is kept
 * separate from `session.ts` because `next/headers` cannot be bundled into
 * Edge middleware — middleware uses `getSessionFromRequest()` from
 * `session.ts` instead. Server Components (#356's `/edit/*` pages) and Route
 * Handlers (`/api/edit/*`) consume this; B02 #101 layers the live
 * `isSuperuser` check on top.
 */
import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { getSessionConfig } from "@/lib/auth/config";
import { readSessionValue, type SessionData } from "@/lib/auth/session";

/**
 * The current session, or `null` when unauthenticated. Safe to call from any
 * Server Component or Route Handler.
 *
 * Wrapped in React `cache()` so the cookie decrypt runs at most once per server
 * request/render — repeat callers within the same request share the result.
 * This is request-scoped memoization only: it does NOT persist across requests
 * or cache the session, so each new request reads and re-validates the cookie
 * afresh.
 */
export const getSession = cache(async (): Promise<SessionData | null> => {
  const cfg = getSessionConfig();
  const store = await cookies();
  return readSessionValue(store.get(cfg.cookieName)?.value);
});

export type { SessionData };
