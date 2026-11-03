// @vitest-environment node
/**
 * ADR-013 D5 — 2h idle timeout on top of the 8h absolute cap.
 *
 * `readSessionValue` rejects a session whose sealed `lastSeen` is older than
 * the idle timeout; the proxy slides the window on authenticated gated
 * requests by re-sealing with a fresh `lastSeen` and the ORIGINAL `exp`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { sealData } from "iron-session";
import { proxy } from "@/proxy";
import {
  createSessionCookie,
  readSessionValue,
  refreshSessionCookie,
  sessionNeedsIdleRefresh,
  withImpersonation,
  type SessionData,
} from "@/lib/auth/session";
import { getSessionConfig } from "@/lib/auth/config";

const SECRET = "test-session-secret-0123456789-0123456789";
vi.stubEnv("SESSION_COOKIE_SECRET", SECRET);
afterAll(() => vi.unstubAllEnvs());

const ORIGIN = "https://scholars.weill.cornell.edu";
const T0 = 1_800_000_000; // fixed epoch seconds
const IDLE = 2 * 60 * 60;
const CAP = 8 * 60 * 60;

function at(seconds: number): void {
  vi.setSystemTime(new Date(seconds * 1000));
}

function requestWith(path: string, cookieValue: string): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    headers: { cookie: `__Host-sps_session=${cookieValue}` },
  });
}

/** The sealed value the proxy set on the response, or null when it set none. */
function setSessionValue(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const m = /__Host-sps_session=([^;]*)/.exec(raw);
  return m ? m[1] : null;
}

/** Unseal without the idle/exp checks, to inspect exactly what was written. */
async function rawPayload(value: string): Promise<SessionData> {
  const { unsealData } = await import("iron-session");
  return unsealData<SessionData>(value, { password: SECRET, ttl: CAP });
}

beforeEach(() => {
  vi.useFakeTimers();
  at(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("config", () => {
  it("defaults the idle timeout to 7200s and the refresh threshold to 300s", () => {
    const cfg = getSessionConfig();
    expect(cfg.idleTimeoutSeconds).toBe(7200);
    expect(cfg.idleRefreshThresholdSeconds).toBe(300);
  });

  it("honours SESSION_IDLE_TIMEOUT_SECONDS, clamped to [60s, ttl]", () => {
    vi.stubEnv("SESSION_IDLE_TIMEOUT_SECONDS", "600");
    expect(getSessionConfig().idleTimeoutSeconds).toBe(600);
    vi.stubEnv("SESSION_IDLE_TIMEOUT_SECONDS", "999999");
    expect(getSessionConfig().idleTimeoutSeconds).toBe(CAP);
    vi.stubEnv("SESSION_IDLE_TIMEOUT_SECONDS", "1");
    expect(getSessionConfig().idleTimeoutSeconds).toBe(60);
    vi.stubEnv("SESSION_IDLE_TIMEOUT_SECONDS", "");
  });
});

describe("readSessionValue — idle timeout", () => {
  it("stamps lastSeen = iat on a new session", async () => {
    const c = await createSessionCookie("abc1234");
    const s = await readSessionValue(c.value);
    expect(s?.lastSeen).toBe(T0);
    expect(s?.iat).toBe(T0);
  });

  it("accepts a session idle for just under 2h", async () => {
    const c = await createSessionCookie("abc1234");
    at(T0 + IDLE);
    expect((await readSessionValue(c.value))?.cwid).toBe("abc1234");
  });

  it("rejects an idle-expired session even though exp has not passed", async () => {
    const c = await createSessionCookie("abc1234");
    at(T0 + IDLE + 1);
    expect(await readSessionValue(c.value)).toBeNull();
  });

  it("uses a configured idle timeout", async () => {
    vi.stubEnv("SESSION_IDLE_TIMEOUT_SECONDS", "600");
    try {
      const c = await createSessionCookie("abc1234");
      at(T0 + 601);
      expect(await readSessionValue(c.value)).toBeNull();
    } finally {
      vi.stubEnv("SESSION_IDLE_TIMEOUT_SECONDS", "");
    }
  });
});

describe("refreshSessionCookie", () => {
  it("an active session is accepted, refreshed, and survives past the first idle window", async () => {
    const c = await createSessionCookie("abc1234");
    at(T0 + 3600);
    const s = (await readSessionValue(c.value))!;
    expect(sessionNeedsIdleRefresh(s)).toBe(true);
    const refreshed = await refreshSessionCookie(s);

    at(T0 + 3600 + IDLE - 1); // well past T0 + IDLE
    expect(await readSessionValue(c.value)).toBeNull(); // the old cookie idled out
    const r = await readSessionValue(refreshed.value);
    expect(r?.cwid).toBe("abc1234");
    expect(r?.lastSeen).toBe(T0 + 3600);
  });

  it("never extends the absolute exp", async () => {
    const c = await createSessionCookie("abc1234");
    const original = (await readSessionValue(c.value))!;
    expect(original.exp).toBe(T0 + CAP);

    // Keep the session active right up to the cap.
    let value = c.value;
    for (let t = T0 + 3600; t < T0 + CAP; t += 3600) {
      at(t);
      const s = (await readSessionValue(value))!;
      expect(s).not.toBeNull();
      const next = await refreshSessionCookie(s);
      expect(next.options.maxAge).toBe(T0 + CAP - t);
      value = next.value;
      const payload = await rawPayload(value);
      expect(payload.exp).toBe(T0 + CAP);
      expect(payload.iat).toBe(T0);
      expect(payload.lastSeen).toBe(t);
    }
    at(T0 + CAP);
    expect(await readSessionValue(value)).toBeNull();
  });

  it("keeps an impersonation overlay and stamps lastSeen on withImpersonation", async () => {
    const c = await createSessionCookie("abc1234");
    at(T0 + 1000);
    const s = (await readSessionValue(c.value))!;
    const imp = await withImpersonation(s, "xyz9999");
    at(T0 + 2000);
    const refreshed = await refreshSessionCookie((await readSessionValue(imp.value))!);
    const p = await rawPayload(refreshed.value);
    expect(p.impersonating?.targetCwid).toBe("xyz9999");
    expect(p.exp).toBe(T0 + CAP);
    expect(p.lastSeen).toBe(T0 + 2000);
  });
});

describe("legacy cookie without lastSeen", () => {
  async function legacySeal(iat: number): Promise<string> {
    return sealData({ cwid: "abc1234", iat, exp: iat + CAP }, { password: SECRET, ttl: CAP });
  }

  it("is accepted even when issued more than 2h ago, and flagged for stamping", async () => {
    const value = await legacySeal(T0 - 5 * 3600);
    const s = await readSessionValue(value);
    expect(s?.cwid).toBe("abc1234");
    expect(s?.lastSeen).toBeUndefined();
    expect(sessionNeedsIdleRefresh(s!)).toBe(true);
  });

  it("is stamped by the proxy, then idles out normally", async () => {
    const value = await legacySeal(T0 - 3600);
    const res = await proxy(requestWith("/edit", value));
    expect(res.status).toBe(200);
    const stamped = setSessionValue(res);
    expect(stamped).not.toBeNull();
    const p = await rawPayload(stamped!);
    expect(p.lastSeen).toBe(T0);
    expect(p.exp).toBe(T0 - 3600 + CAP);

    at(T0 + IDLE + 1);
    expect(await readSessionValue(stamped!)).toBeNull();
  });
});

describe("proxy — idle refresh", () => {
  it("does not re-seal under the refresh threshold", async () => {
    const c = await createSessionCookie("abc1234");
    expect(sessionNeedsIdleRefresh((await readSessionValue(c.value))!)).toBe(false);
    at(T0 + 299);
    const s = (await readSessionValue(c.value))!;
    expect(sessionNeedsIdleRefresh(s)).toBe(false);
    const res = await proxy(requestWith("/edit", c.value));
    expect(res.status).toBe(200);
    expect(setSessionValue(res)).toBeNull();
  });

  it("re-seals at the threshold, keeps exp, and forwards the new cookie to the handler", async () => {
    const c = await createSessionCookie("abc1234");
    at(T0 + 300);
    const res = await proxy(requestWith("/api/edit/field", c.value));
    expect(res.status).toBe(200);
    const next = setSessionValue(res);
    expect(next).not.toBeNull();
    const p = await rawPayload(next!);
    expect(p.lastSeen).toBe(T0 + 300);
    expect(p.exp).toBe(T0 + CAP);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=28500/);
    // The downstream request sees the refreshed cookie, not the stale one.
    expect(res.headers.get("x-middleware-request-cookie") ?? "").toContain(next!);
  });

  it("redirects an idle-expired /edit page request to SSO login", async () => {
    const c = await createSessionCookie("abc1234");
    at(T0 + IDLE + 1);
    const res = await proxy(requestWith("/edit/scholar/abc1234", c.value));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!, ORIGIN);
    expect(loc.pathname).toBe("/api/auth/saml/login");
    expect(loc.searchParams.get("return")).toBe("/edit/scholar/abc1234");
    expect(setSessionValue(res)).toBeNull();
  });

  it("returns 401 for an idle-expired /api/edit request", async () => {
    const c = await createSessionCookie("abc1234");
    at(T0 + IDLE + 1);
    const res = await proxy(requestWith("/api/edit/field", c.value));
    expect(res.status).toBe(401);
  });

  it("never touches the session on a public page", async () => {
    const c = await createSessionCookie("abc1234");
    at(T0 + 3600);
    const res = await proxy(requestWith("/scholars/someone", c.value));
    expect(setSessionValue(res)).toBeNull();
  });
});
