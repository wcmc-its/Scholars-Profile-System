import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { createSessionCookie } from "@/lib/auth/session";

process.env.SESSION_COOKIE_SECRET = "test-session-secret-0123456789-0123456789";

const ORIGIN = "https://scholars.weill.cornell.edu";

async function authedRequest(path: string): Promise<NextRequest> {
  const cookie = await createSessionCookie("abc1234");
  return new NextRequest(`${ORIGIN}${path}`, {
    headers: { cookie: `${cookie.name}=${cookie.value}` },
  });
}

describe("middleware — SSO gate", () => {
  it("redirects an unauthenticated /edit request to SSO login", async () => {
    const res = await middleware(new NextRequest(`${ORIGIN}/edit`));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/api/auth/saml/login");
    expect(loc.searchParams.get("return")).toBe("/edit");
  });

  it("preserves the intended path and query in the return parameter", async () => {
    const res = await middleware(
      new NextRequest(`${ORIGIN}/edit/scholar/abc1234?tab=overview`),
    );
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("return")).toBe(
      "/edit/scholar/abc1234?tab=overview",
    );
  });

  it("returns a bare 401 for an unauthenticated /api/edit request", async () => {
    const res = await middleware(new NextRequest(`${ORIGIN}/api/edit/field`));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(res.headers.get("location")).toBeNull();
  });

  it("passes an authenticated /edit request through", async () => {
    const res = await middleware(await authedRequest("/edit"));
    expect(res.status).not.toBe(302);
    expect(res.status).not.toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("treats a garbage session cookie as unauthenticated", async () => {
    const res = await middleware(
      new NextRequest(`${ORIGIN}/edit`, {
        headers: { cookie: "__Secure-sps_session=not-a-valid-seal" },
      }),
    );
    expect(res.status).toBe(302);
  });
});
