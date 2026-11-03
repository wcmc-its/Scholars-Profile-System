/**
 * B01 — session cookie (issue #100).
 *
 * A stateless, encrypted session cookie. The payload is the user's CWID plus
 * issued-at / expiry, sealed with iron-session (AEAD over Web Crypto, so it
 * seals and unseals in both the Node and Edge runtimes). "Validated
 * server-side on every request" (#100 AC) here means decrypt + expiry check +
 * idle check — there is no server-side session store.
 *
 * Idle timeout (ADR-013 D5): the payload also carries `lastSeen`. A session
 * whose `lastSeen` is older than the idle timeout (default 2h) is rejected even
 * before its absolute `exp`. The proxy slides the window by re-sealing the
 * cookie with a fresh `lastSeen` on authenticated `/edit*` traffic
 * ({@link sessionNeedsIdleRefresh} / {@link refreshSessionCookie}); a re-seal
 * always keeps the original `exp`, so activity never extends the 8h cap.
 *
 * The payload holds identity only — no group or role. B02 #101 computes
 * `isSuperuser` from a live group lookup per request and must never read it
 * from this cookie (self-edit-spec.md § Authorization — re-evaluated, never
 * cached for the session).
 *
 * Edge-safe: this module imports only iron-session, the config, and the
 * `NextRequest` *type*. The `next/headers`-based `getSession()` for Server
 * Components lives in `session-server.ts`, which middleware must not import.
 */
import type { NextRequest } from "next/server";
import { sealData, unsealData } from "iron-session";
import { getSessionConfig } from "@/lib/auth/config";

export interface SessionData {
  /** The signed-in scholar's CWID — the SAML assertion subject. */
  cwid: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds (`iat + ttl`; ttl is hard-capped at 8h by config). */
  exp: number;
  /**
   * Last authenticated activity, epoch seconds (ADR-013 D5). Drives the idle
   * timeout. Optional only for cookies sealed before the idle timeout shipped:
   * those are accepted and stamped on their next gated request (never logged
   * out by the deploy), and all of them age out within 8h via `exp`.
   */
  lastSeen?: number;
  /**
   * "View as" overlay (#637, impersonation-spec.md §2). Present only while a
   * superuser is viewing/acting as another user. `cwid` above stays the real
   * SAML subject and is NEVER mutated — the overlay rides inside the same AEAD
   * seal (unforgeable without the key), so the effective identity is decided
   * by `lib/auth/effective-identity.ts`, never by re-minting the cookie. The
   * `startedAt` epoch-seconds stamp feeds the read-time TTL (R6).
   */
  impersonating?: { targetCwid: string; startedAt: number };
}

/** A cookie ready for `NextResponse.cookies.set(name, value, options)`. */
export interface SerializedSessionCookie {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    secure: boolean;
    sameSite: "lax";
    path: "/";
    domain: string | undefined;
    maxAge: number;
  };
}

/** Current time in epoch seconds — the unit the cookie's `iat`/`exp` use. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Mint a session cookie for `cwid`. The returned value is sealed; the caller
 * applies it to a response: `res.cookies.set(c.name, c.value, c.options)`.
 */
export async function createSessionCookie(
  cwid: string,
): Promise<SerializedSessionCookie> {
  const cfg = getSessionConfig();
  const iat = nowSeconds();
  const data: SessionData = {
    cwid,
    iat,
    exp: iat + cfg.ttlSeconds,
    lastSeen: iat,
  };
  const value = await sealData(data, {
    password: cfg.secret,
    ttl: cfg.ttlSeconds,
  });
  return {
    name: cfg.cookieName,
    value,
    options: {
      httpOnly: true,
      secure: cfg.cookieSecure,
      sameSite: "lax",
      path: "/",
      domain: cfg.cookieDomain,
      maxAge: cfg.ttlSeconds,
    },
  };
}

/**
 * Re-seal an existing session with a fresh payload, preserving its `iat`/`exp`
 * (#637). The shared path behind `withImpersonation` / `withoutImpersonation`:
 * toggling the overlay must NOT extend the session — the original 8h `exp` is
 * the authoritative cap (R6). The seal `ttl` and the cookie `maxAge` are both
 * derived from the time remaining to the preserved `exp`, never reset to a full
 * `cfg.ttlSeconds`. `maxAge` is floored at 1s so the browser keeps the cookie
 * even within the final second before expiry (the `exp` check still gates it).
 *
 * Every re-seal is driven by an authenticated request, so it also stamps
 * `lastSeen` (ADR-013 D5 idle timeout) — and only `lastSeen`; `iat`/`exp` are
 * carried over untouched.
 */
async function reseal(data: SessionData): Promise<SerializedSessionCookie> {
  const cfg = getSessionConfig();
  const now = nowSeconds();
  const remaining = Math.max(data.exp - now, 1);
  const value = await sealData(
    { ...data, lastSeen: now },
    { password: cfg.secret, ttl: remaining },
  );
  return {
    name: cfg.cookieName,
    value,
    options: {
      httpOnly: true,
      secure: cfg.cookieSecure,
      sameSite: "lax",
      path: "/",
      domain: cfg.cookieDomain,
      maxAge: remaining,
    },
  };
}

/**
 * Re-seal `session` with the "view as" overlay set to `targetCwid` (#637). The
 * real `cwid`, `iat`, and `exp` are preserved exactly; `startedAt` is stamped
 * now, so the read-time TTL in `effective-identity.ts` measures from this call.
 * Starting a second target simply replaces the overlay (spec test E7).
 */
export async function withImpersonation(
  session: SessionData,
  targetCwid: string,
): Promise<SerializedSessionCookie> {
  return reseal({
    ...session,
    impersonating: { targetCwid, startedAt: nowSeconds() },
  });
}

/**
 * Re-seal `session` with the overlay dropped — "Return to my view" (#637).
 * Preserves `iat`/`exp`; idempotent when no overlay is present (spec test E8).
 */
export async function withoutImpersonation(
  session: SessionData,
): Promise<SerializedSessionCookie> {
  const { impersonating: _dropped, ...rest } = session;
  return reseal(rest);
}

/**
 * Whether an authenticated request should re-seal `session` to slide its idle
 * window (ADR-013 D5). True when `lastSeen` is absent (a cookie sealed before
 * the idle timeout shipped: stamp it now) or at least the refresh threshold old.
 * Below the threshold the cookie is left alone, so a burst of requests does not
 * set a cookie on every response.
 */
export function sessionNeedsIdleRefresh(
  session: SessionData,
  now: number = nowSeconds(),
): boolean {
  if (typeof session.lastSeen !== "number") return true;
  return now - session.lastSeen >= getSessionConfig().idleRefreshThresholdSeconds;
}

/**
 * Re-seal `session` with `lastSeen` = now, keeping `cwid`, `iat`, `exp` and any
 * impersonation overlay exactly as they were. The idle refresh can never extend
 * the absolute 8h cap: the seal ttl and cookie `maxAge` are the time remaining
 * to the ORIGINAL `exp`.
 */
export async function refreshSessionCookie(
  session: SessionData,
): Promise<SerializedSessionCookie> {
  return reseal(session);
}

/** A cookie that clears the session — empty value, immediate expiry. */
export function clearedSessionCookie(): SerializedSessionCookie {
  const cfg = getSessionConfig();
  return {
    name: cfg.cookieName,
    value: "",
    options: {
      httpOnly: true,
      secure: cfg.cookieSecure,
      sameSite: "lax",
      path: "/",
      domain: cfg.cookieDomain,
      maxAge: 0,
    },
  };
}

/**
 * Unseal and validate a sealed cookie value. Returns the session, or `null`
 * for anything that is not a live, well-formed session — absent, tampered,
 * sealed with a different key, expired, idle past the idle timeout, or missing
 * a CWID. Never throws.
 */
export async function readSessionValue(
  sealed: string | undefined | null,
): Promise<SessionData | null> {
  if (!sealed) return null;
  const cfg = getSessionConfig();
  let data: SessionData;
  try {
    data = await unsealData<SessionData>(sealed, {
      password: cfg.secret,
      ttl: cfg.ttlSeconds,
    });
  } catch {
    // Tampered, truncated, or sealed with a retired key — treat as no session.
    return null;
  }
  if (
    !data ||
    typeof data.cwid !== "string" ||
    data.cwid.length === 0 ||
    typeof data.exp !== "number"
  ) {
    return null;
  }
  // Explicit expiry check on the sealed `exp` — the authoritative 8h cap,
  // immune to any later change in the configured ttl.
  const now = nowSeconds();
  if (data.exp <= now) return null;
  // Idle timeout (ADR-013 D5). A cookie with no `lastSeen` predates the idle
  // timeout; it is accepted (the proxy stamps it on the next gated request)
  // rather than logging every editor out on deploy. `exp` still bounds it.
  if (
    typeof data.lastSeen === "number" &&
    now - data.lastSeen > cfg.idleTimeoutSeconds
  ) {
    return null;
  }
  return data;
}

/**
 * Read and validate the session from a `NextRequest` — for middleware and
 * route handlers. Returns `null` when there is no valid session.
 */
export async function getSessionFromRequest(
  request: NextRequest,
): Promise<SessionData | null> {
  const cfg = getSessionConfig();
  return readSessionValue(request.cookies.get(cfg.cookieName)?.value);
}
