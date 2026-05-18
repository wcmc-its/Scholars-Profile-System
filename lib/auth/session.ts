/**
 * B01 — session cookie (issue #100).
 *
 * A stateless, encrypted session cookie. The payload is the user's CWID plus
 * issued-at / expiry, sealed with iron-session (AEAD over Web Crypto, so it
 * seals and unseals in both the Node and Edge runtimes). "Validated
 * server-side on every request" (#100 AC) here means decrypt + expiry check —
 * there is no server-side session store.
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

function nowSeconds(): number {
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
  const data: SessionData = { cwid, iat, exp: iat + cfg.ttlSeconds };
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
 * sealed with a different key, expired, or missing a CWID. Never throws.
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
  if (data.exp <= nowSeconds()) return null;
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
