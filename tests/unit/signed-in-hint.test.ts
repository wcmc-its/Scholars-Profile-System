// @vitest-environment node
/**
 * The signed-in hint cookie (`lib/auth/session.ts`): a JS-readable, identity-free
 * `…sps_signed_in=1` that mirrors the httpOnly session cookie so the client can
 * skip the `/api/auth/session` probe when it is certainly signed out. These pin
 * that it carries the session cookie's attributes and lifetime and is NOT
 * httpOnly, and that it is set / cleared at every session write site that has
 * no other test here: impersonation start/stop and `GET /api/auth/session`.
 * (SAML callback + logout: auth-routes.test.ts; proxy idle refresh:
 * session-idle-timeout.test.ts.)
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  session: null as null | { cwid: string; iat: number; exp: number; lastSeen?: number },
}));

vi.mock("@/lib/auth/session-server", () => ({ getSession: async () => h.session }));
vi.mock("@/lib/auth/effective-identity", () => ({
  canImpersonate: async () => true,
  assertImpersonable: async () => ({ ok: true }),
  impersonationActive: () => false,
}));
vi.mock("@/lib/auth/comms-steward", () => ({ isCommsSteward: async () => false }));
vi.mock("@/lib/auth/global-roles", () => ({ resolveGlobalRole: async () => null }));
vi.mock("@/lib/auth/superuser", () => ({ isSuperuser: async () => false }));
vi.mock("@/lib/auth/development", () => ({ isDeveloper: async () => false }));
vi.mock("@/lib/auth/content-editor", () => ({ isContentEditor: async () => false }));
vi.mock("@/lib/auth/observer", () => ({ isObserver: async () => false }));
vi.mock("@/lib/edit/manageable-units", () => ({ loadManageableUnits: async () => ({ total: 0 }) }));
vi.mock("@/lib/sources/ldap", () => ({ fetchDirectoryPeopleByCwid: async () => [] }));
vi.mock("@/lib/edit/authz", () => ({ verifyRequestOrigin: () => ({ ok: true }) }));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: async () => {} }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: {
        findFirst: async () => ({ cwid: "tgt0001" }),
        findUnique: async () => ({ slug: "a-b", preferredName: "A B" }),
      },
      stewardDirectory: { findUnique: async () => null },
    },
    write: { $transaction: async (fn: (tx: unknown) => Promise<void>) => fn({}) },
  },
}));

import {
  applySessionCookie,
  clearedSessionCookie,
  createSessionCookie,
  signedInHintName,
  withImpersonation,
} from "@/lib/auth/session";
import { SIGNED_IN_HINT_NAMES, SIGNED_OUT } from "@/components/site/session-probe";
import { GET as sessionGET } from "@/app/api/auth/session/route";
import {
  DELETE as impersonationDELETE,
  POST as impersonationPOST,
} from "@/app/api/impersonation/route";

vi.stubEnv("SESSION_COOKIE_SECRET", "test-session-secret-0123456789-0123456789");
afterAll(() => vi.unstubAllEnvs());

const T0 = 1_800_000_000;
const CAP = 8 * 60 * 60;
const HINT = "__Host-sps_signed_in";

/** The raw Set-Cookie line for `name`, to check attributes the parsed view hides. */
function rawSetCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0 * 1000));
  h.session = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("applySessionCookie", () => {
  it("writes the session cookie and a non-httpOnly hint with the same attributes and maxAge", async () => {
    const res = new NextResponse(null);
    const cookie = await createSessionCookie("abc1234");
    applySessionCookie(res, cookie);

    expect(res.cookies.get("__Host-sps_session")?.value).toBe(cookie.value);
    const hint = res.cookies.get(HINT);
    expect(hint?.value).toBe("1");
    expect(hint?.maxAge).toBe(cookie.options.maxAge);
    const raw = rawSetCookie(res, HINT)!;
    expect(raw).toMatch(/Path=\//);
    expect(raw).toMatch(/Secure/);
    expect(raw).toMatch(/SameSite=lax/i);
    expect(raw).not.toMatch(/HttpOnly/i);
    expect(raw).not.toMatch(/Domain=/i);
    // The session cookie itself stays httpOnly.
    expect(rawSetCookie(res, "__Host-sps_session")).toMatch(/HttpOnly/);
  });

  it("carries a re-seal's remaining lifetime, never a fresh 8h", async () => {
    const cookie = await createSessionCookie("abc1234");
    vi.setSystemTime(new Date((T0 + 3600) * 1000));
    const resealed = await withImpersonation(
      { cwid: "abc1234", iat: T0, exp: T0 + CAP, lastSeen: T0 },
      "tgt0001",
    );
    const res = new NextResponse(null);
    applySessionCookie(res, resealed);
    expect(cookie.options.maxAge).toBe(CAP);
    expect(res.cookies.get(HINT)?.maxAge).toBe(CAP - 3600);
  });

  it("clears the hint beside a session clear", () => {
    const res = new NextResponse(null);
    applySessionCookie(res, clearedSessionCookie());
    expect(res.cookies.get(HINT)?.value).toBe("");
    expect(res.cookies.get(HINT)?.maxAge).toBe(0);
  });

  it("drops the __Host- prefix with a local-http session cookie name", async () => {
    vi.stubEnv("SESSION_COOKIE_NAME", "sps_session");
    vi.stubEnv("SESSION_COOKIE_SECURE", "false");
    try {
      const res = new NextResponse(null);
      applySessionCookie(res, await createSessionCookie("abc1234"));
      expect(res.cookies.get("sps_signed_in")?.value).toBe("1");
      expect(res.cookies.get(HINT)).toBeUndefined();
      expect(rawSetCookie(res, "sps_signed_in")).not.toMatch(/Secure/);
    } finally {
      vi.stubEnv("SESSION_COOKIE_NAME", "");
      vi.stubEnv("SESSION_COOKIE_SECURE", "");
    }
  });
});

describe("GET /api/auth/session", () => {
  it("sets the hint, expiring with the session, when the session is valid", async () => {
    h.session = { cwid: "abc1234", iat: T0 - 600, exp: T0 - 600 + CAP, lastSeen: T0 };
    const res = await sessionGET();
    expect((await res.json()).authenticated).toBe(true);
    expect(res.cookies.get(HINT)?.value).toBe("1");
    expect(res.cookies.get(HINT)?.maxAge).toBe(CAP - 600);
    expect(rawSetCookie(res, HINT)).not.toMatch(/HttpOnly/i);
  });

  it("clears the hint when there is no valid session", async () => {
    const res = await sessionGET();
    expect((await res.json()).authenticated).toBe(false);
    expect(res.cookies.get(HINT)?.value).toBe("");
    expect(res.cookies.get(HINT)?.maxAge).toBe(0);
  });
});

describe("/api/impersonation", () => {
  const request = (method: "POST" | "DELETE") =>
    new NextRequest("https://scholars.example.org/api/impersonation", {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify({ targetCwid: "tgt0001" }) : undefined,
    });

  beforeEach(() => {
    vi.stubEnv("IMPERSONATION_ENABLED", "true");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.session = { cwid: "su00001", iat: T0 - 600, exp: T0 - 600 + CAP, lastSeen: T0 - 60 };
  });

  it("start re-seals the session and sets the hint with the same remaining maxAge", async () => {
    const res = await impersonationPOST(request("POST"));
    expect(res.status).toBe(204);
    expect(res.cookies.get("__Host-sps_session")?.value).toBeTruthy();
    expect(res.cookies.get(HINT)?.value).toBe("1");
    expect(res.cookies.get(HINT)?.maxAge).toBe(res.cookies.get("__Host-sps_session")?.maxAge);
    expect(res.cookies.get(HINT)?.maxAge).toBe(CAP - 600);
  });

  it("stop re-seals the session and sets the hint with the same remaining maxAge", async () => {
    const res = await impersonationDELETE(request("DELETE"));
    expect(res.status).toBe(204);
    expect(res.cookies.get(HINT)?.value).toBe("1");
    expect(res.cookies.get(HINT)?.maxAge).toBe(CAP - 600);
  });
});

// The client gate (components/site/session-probe.ts) cannot import the server
// module, so it restates both of these; a drift would show signed-in users as
// signed out (wrong names) or change what a signed-out page renders (wrong body).
describe("client gate parity", () => {
  it("looks for exactly the hint names the server writes", () => {
    expect(SIGNED_IN_HINT_NAMES).toEqual([
      signedInHintName("__Host-sps_session"),
      signedInHintName("sps_session"),
    ]);
  });

  it("answers signed-out exactly as GET /api/auth/session does", async () => {
    expect(await (await sessionGET()).json()).toEqual(SIGNED_OUT);
  });
});
