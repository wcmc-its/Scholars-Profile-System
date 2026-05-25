import { readFileSync } from "node:fs";
import path from "node:path";
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
    const loc = new URL(res.headers.get("location")!, ORIGIN);
    expect(loc.pathname).toBe("/api/auth/saml/login");
    expect(loc.searchParams.get("return")).toBe("/edit");
  });

  it("preserves the intended path and query in the return parameter", async () => {
    const res = await middleware(
      new NextRequest(`${ORIGIN}/edit/scholar/abc1234?tab=overview`),
    );
    const loc = new URL(res.headers.get("location")!, ORIGIN);
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

// B14 — legacy VIVO URL redirect set (issue #113).
//
// The CWID corpus is the build-time-generated `data/vivo-redirects.json`
// produced by `scripts/etl/generate-vivo-redirect-set.ts`. Read it directly
// so the assertions track the real generated set; pick the first and last
// CWIDs as in-set anchors plus an obviously-fake one for the negative path.
const REDIRECT_SET = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), "data", "vivo-redirects.json"),
    "utf8",
  ),
) as string[];
const KNOWN_CWID = REDIRECT_SET[0]!;
const KNOWN_CWID_LATE = REDIRECT_SET[REDIRECT_SET.length - 1]!;
const UNKNOWN_CWID = "zzz9999notincorpus";

describe("middleware — B14 legacy VIVO redirects", () => {
  it("301s /display/cwid-{cwid} to /scholars/by-cwid/{cwid} when the CWID is in the set (B14-3)", async () => {
    const res = await middleware(
      new NextRequest(`${ORIGIN}/display/cwid-${KNOWN_CWID}`),
    );
    expect(res.status).toBe(301);
    const loc = new URL(res.headers.get("location")!, ORIGIN);
    expect(loc.pathname).toBe(`/scholars/by-cwid/${KNOWN_CWID}`);
  });

  it("301s /individual/cwid-{cwid} to /scholars/by-cwid/{cwid} for the late-bucket anchor (B14-5)", async () => {
    const res = await middleware(
      new NextRequest(`${ORIGIN}/individual/cwid-${KNOWN_CWID_LATE}`),
    );
    expect(res.status).toBe(301);
    const loc = new URL(res.headers.get("location")!, ORIGIN);
    expect(loc.pathname).toBe(`/scholars/by-cwid/${KNOWN_CWID_LATE}`);
  });

  it("301s /profile/cwid-{cwid} too (defensive coverage; B14-5)", async () => {
    const res = await middleware(
      new NextRequest(`${ORIGIN}/profile/cwid-${KNOWN_CWID}`),
    );
    expect(res.status).toBe(301);
    const loc = new URL(res.headers.get("location")!, ORIGIN);
    expect(loc.pathname).toBe(`/scholars/by-cwid/${KNOWN_CWID}`);
  });

  it("passes through (no redirect) when the CWID is not in the set (B14-4)", async () => {
    const res = await middleware(
      new NextRequest(`${ORIGIN}/display/cwid-${UNKNOWN_CWID}`),
    );
    // NextResponse.next() yields a non-redirect; default status is 200 with a
    // x-middleware-next: 1 marker. The location header is unset.
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).not.toBe(301);
    expect(res.status).not.toBe(302);
  });

  it("strips any query string from the canonical redirect target", async () => {
    const res = await middleware(
      new NextRequest(`${ORIGIN}/display/cwid-${KNOWN_CWID}?utm=campaign`),
    );
    expect(res.status).toBe(301);
    const loc = new URL(res.headers.get("location")!, ORIGIN);
    expect(loc.search).toBe("");
    expect(loc.pathname).toBe(`/scholars/by-cwid/${KNOWN_CWID}`);
  });

  it("does not run the SSO gate on legacy VIVO paths (no 302 even when unauthenticated)", async () => {
    const res = await middleware(
      new NextRequest(`${ORIGIN}/display/cwid-${KNOWN_CWID}`),
    );
    expect(res.status).not.toBe(302);
    const loc = res.headers.get("location");
    if (loc !== null) {
      expect(new URL(loc, ORIGIN).pathname).not.toBe("/api/auth/saml/login");
    }
  });
});
