import { describe, expect, it } from "vitest";
import { sealData } from "iron-session";
import {
  createSessionCookie,
  readSessionValue,
  type SessionData,
} from "@/lib/auth/session";

// getSessionConfig() reads this lazily at call time, so setting it here is
// enough — no need to set it before the imports above.
const SECRET = "test-session-secret-0123456789-0123456789";
process.env.SESSION_COOKIE_SECRET = SECRET;

describe("createSessionCookie / readSessionValue", () => {
  it("round-trips a session for a CWID", async () => {
    const cookie = await createSessionCookie("abc1234");
    expect(cookie.name).toBe("__Secure-sps_session");
    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.sameSite).toBe("lax");
    expect(cookie.options.maxAge).toBeGreaterThan(0);
    expect(cookie.options.maxAge).toBeLessThanOrEqual(28800);

    const session = await readSessionValue(cookie.value);
    expect(session?.cwid).toBe("abc1234");
    expect(session!.exp).toBeGreaterThan(session!.iat);
  });

  it("returns null for an absent cookie value", async () => {
    expect(await readSessionValue(undefined)).toBeNull();
    expect(await readSessionValue(null)).toBeNull();
    expect(await readSessionValue("")).toBeNull();
  });

  it("returns null for a tampered seal", async () => {
    const cookie = await createSessionCookie("abc1234");
    const tampered = cookie.value.slice(0, -4) + "AAAA";
    expect(await readSessionValue(tampered)).toBeNull();
  });

  it("returns null for a seal made with a different secret", async () => {
    const foreign = await sealData(
      { cwid: "abc1234", iat: 1, exp: 2_000_000_000 } satisfies SessionData,
      { password: "another-secret-key-of-at-least-32-characters" },
    );
    expect(await readSessionValue(foreign)).toBeNull();
  });

  it("returns null for an expired payload", async () => {
    // Sealed now (so iron-session's own ttl is satisfied) but with an `exp`
    // in the past — exercises the explicit expiry check in readSessionValue.
    const expired = await sealData(
      { cwid: "abc1234", iat: 100, exp: 200 } satisfies SessionData,
      { password: SECRET },
    );
    expect(await readSessionValue(expired)).toBeNull();
  });

  it("returns null when the payload carries no cwid", async () => {
    const noCwid = await sealData(
      { iat: 1, exp: 2_000_000_000 },
      { password: SECRET },
    );
    expect(await readSessionValue(noCwid)).toBeNull();
  });
});
