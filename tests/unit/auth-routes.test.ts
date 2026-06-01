import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";

// Mock the SAML library boundary: the route logic is exercised without a real
// IdP or SAML config. node-saml's own crypto validation is its responsibility
// and is covered end-to-end by the staging smoke test (#100 AC 6).
vi.mock("@/lib/auth/saml", () => ({
  getLoginRedirectUrl: vi.fn(),
  validateSamlResponse: vi.fn(),
}));

import { NextRequest } from "next/server";
import { getLoginRedirectUrl, validateSamlResponse } from "@/lib/auth/saml";
import { GET as loginGET } from "@/app/api/auth/saml/login/route";
import { POST as callbackPOST } from "@/app/api/auth/saml/callback/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";

// Real session minting is used in the success-path test.
vi.stubEnv("SESSION_COOKIE_SECRET", "test-session-secret-0123456789-0123456789");

// Restore the env so it can't leak into a later file if isolation is ever
// relaxed (#660).
afterAll(() => vi.unstubAllEnvs());

const mockedLoginUrl = vi.mocked(getLoginRedirectUrl);
const mockedValidate = vi.mocked(validateSamlResponse);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const LOGIN = "https://scholars.weill.cornell.edu/api/auth/saml/login";
const CALLBACK = "https://scholars.weill.cornell.edu/api/auth/saml/callback";

describe("GET /api/auth/saml/login", () => {
  it("302-redirects to the IdP URL returned by getLoginRedirectUrl", async () => {
    mockedLoginUrl.mockResolvedValue("https://idp.example/sso?SAMLRequest=abc");
    const res = await loginGET(new NextRequest(`${LOGIN}?return=/edit/scholar/abc1234`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://idp.example/sso?SAMLRequest=abc");
  });

  it("passes a safe return path through as RelayState", async () => {
    mockedLoginUrl.mockResolvedValue("https://idp.example/sso");
    await loginGET(new NextRequest(`${LOGIN}?return=/edit/foo`));
    expect(mockedLoginUrl).toHaveBeenCalledWith("/edit/foo");
  });

  it("falls back to the default path for an off-site return value", async () => {
    mockedLoginUrl.mockResolvedValue("https://idp.example/sso");
    await loginGET(new NextRequest(`${LOGIN}?return=https://evil.com`));
    expect(mockedLoginUrl).toHaveBeenCalledWith("/edit");
  });

  it("returns 503 when SAML is not configured", async () => {
    mockedLoginUrl.mockRejectedValue(new Error("not configured"));
    const res = await loginGET(new NextRequest(LOGIN));
    expect(res.status).toBe(503);
  });
});

describe("POST /api/auth/saml/callback", () => {
  function callbackRequest(body: Record<string, string>): NextRequest {
    return new NextRequest(CALLBACK, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  }

  it("400s when SAMLResponse is missing", async () => {
    const res = await callbackPOST(callbackRequest({ RelayState: "/edit" }));
    expect(res.status).toBe(400);
  });

  it("401s and writes no cookie when the assertion fails validation", async () => {
    mockedValidate.mockResolvedValue({ ok: false, reason: "invalid_saml_response" });
    const res = await callbackPOST(callbackRequest({ SAMLResponse: "garbage" }));
    expect(res.status).toBe(401);
    expect(res.cookies.get("__Secure-sps_session")).toBeUndefined();
  });

  it("mints a session cookie and 302s to the RelayState path on success", async () => {
    mockedValidate.mockResolvedValue({ ok: true, cwid: "abc1234" });
    const res = await callbackPOST(
      callbackRequest({ SAMLResponse: "valid", RelayState: "/edit/scholar/abc1234" }),
    );
    expect(res.status).toBe(302);
    // Relative Location (proxy-safe): the browser resolves it against the
    // public ACS URL it POSTed to, never the container's internal request.url
    // (ip-...:3000 behind CloudFront -> ALB -> Fargate).
    expect(res.headers.get("location")).toBe("/edit/scholar/abc1234");
    expect(res.cookies.get("__Secure-sps_session")?.value).toBeTruthy();
  });

  it("falls back to the default path when RelayState is unsafe", async () => {
    mockedValidate.mockResolvedValue({ ok: true, cwid: "abc1234" });
    const res = await callbackPOST(
      callbackRequest({ SAMLResponse: "valid", RelayState: "https://evil.com" }),
    );
    expect(res.headers.get("location")).toBe("/edit");
  });

  it("503s when SAML is not configured", async () => {
    mockedValidate.mockRejectedValue(new Error("not configured"));
    const res = await callbackPOST(callbackRequest({ SAMLResponse: "x" }));
    expect(res.status).toBe(503);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie and 302s home", async () => {
    const res = await logoutPOST();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cleared = res.cookies.get("__Secure-sps_session");
    expect(cleared?.value).toBe("");
    expect(cleared?.maxAge).toBe(0);
  });
});
