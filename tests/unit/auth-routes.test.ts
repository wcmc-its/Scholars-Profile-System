// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";

// Mock the SAML library boundary: the route logic is exercised without a real
// IdP or SAML config. node-saml's own crypto validation is its responsibility
// and is covered end-to-end by the staging smoke test (#100 AC 6).
vi.mock("@/lib/auth/saml", () => ({
  getLoginRedirectUrl: vi.fn(),
  validateSamlResponse: vi.fn(),
}));

// The DB-backed single-use guard (#1439) is exercised on its own in
// saml-assertion-store.test.ts; here it is mocked to drive the callback's
// duplicate-assertion / store-unavailable branches without a database.
vi.mock("@/lib/auth/saml-assertion-store", () => ({
  markAssertionConsumed: vi.fn(),
}));

import { NextRequest } from "next/server";
import { getLoginRedirectUrl, validateSamlResponse } from "@/lib/auth/saml";
import { markAssertionConsumed } from "@/lib/auth/saml-assertion-store";
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
const mockedConsume = vi.mocked(markAssertionConsumed);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Default: a first-use assertion records cleanly.
  mockedConsume.mockResolvedValue({ duplicate: false });
});

const LOGIN = "https://scholars.weill.cornell.edu/api/auth/saml/login";
const CALLBACK = "https://scholars.weill.cornell.edu/api/auth/saml/callback";
const ASSERTION = { id: "assn:_test-assertion", expiresAt: new Date(Date.now() + 60_000) };

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

  it("returns 500 when SAML is not configured", async () => {
    mockedLoginUrl.mockRejectedValue(new Error("not configured"));
    const res = await loginGET(new NextRequest(LOGIN));
    expect(res.status).toBe(500);
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
    mockedValidate.mockResolvedValue({ ok: true, cwid: "abc1234", assertion: ASSERTION });
    const res = await callbackPOST(
      callbackRequest({ SAMLResponse: "valid", RelayState: "/edit/scholar/abc1234" }),
    );
    expect(res.status).toBe(302);
    // Relative Location (proxy-safe): the browser resolves it against the
    // public ACS URL it POSTed to, never the container's internal request.url
    // (ip-...:3000 behind CloudFront -> ALB -> Fargate).
    expect(res.headers.get("location")).toBe("/edit/scholar/abc1234");
    expect(res.cookies.get("__Secure-sps_session")?.value).toBeTruthy();
    // The assertion is recorded single-use before the session is minted (#1439).
    expect(mockedConsume).toHaveBeenCalledWith(ASSERTION);
  });

  it("401s and writes no cookie when the assertion is presented a second time (#1439)", async () => {
    mockedValidate.mockResolvedValue({ ok: true, cwid: "abc1234", assertion: ASSERTION });
    // A second presentation of the same still-valid assertion: the shared store
    // reports it already consumed. Without the single-use guard this same input
    // would 302 + Set-Cookie — so this case fails if the guard is removed.
    mockedConsume.mockResolvedValue({ duplicate: true });
    const res = await callbackPOST(
      callbackRequest({ SAMLResponse: "valid", RelayState: "/edit/scholar/abc1234" }),
    );
    expect(res.status).toBe(401);
    expect(res.cookies.get("__Secure-sps_session")).toBeUndefined();
  });

  it("500s and writes no cookie when the single-use store is unavailable (fail closed)", async () => {
    mockedValidate.mockResolvedValue({ ok: true, cwid: "abc1234", assertion: ASSERTION });
    mockedConsume.mockRejectedValue(new Error("db unreachable"));
    const res = await callbackPOST(
      callbackRequest({ SAMLResponse: "valid", RelayState: "/edit" }),
    );
    expect(res.status).toBe(500);
    expect(res.cookies.get("__Secure-sps_session")).toBeUndefined();
  });

  it("falls back to the default path when RelayState is unsafe", async () => {
    mockedValidate.mockResolvedValue({ ok: true, cwid: "abc1234", assertion: ASSERTION });
    const res = await callbackPOST(
      callbackRequest({ SAMLResponse: "valid", RelayState: "https://evil.com" }),
    );
    expect(res.headers.get("location")).toBe("/edit");
  });

  it("500s when SAML is not configured", async () => {
    mockedValidate.mockRejectedValue(new Error("not configured"));
    const res = await callbackPOST(callbackRequest({ SAMLResponse: "x" }));
    expect(res.status).toBe(500);
  });

  it("400s a non-urlencoded body, as request.formData() did", async () => {
    const req = new NextRequest(CALLBACK, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "SAMLResponse=valid",
    });
    const res = await callbackPOST(req);
    expect(res.status).toBe(400);
    expect(mockedValidate).not.toHaveBeenCalled();
  });

  it("413s on an oversize Content-Length without reading the body", async () => {
    // Handler-level only: deployed, the proxy's body clone has already drained
    // the request before the handler runs (see the note in the route's POST).
    const req = new NextRequest(CALLBACK, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(10 * 1024 * 1024),
      },
      body: "SAMLResponse=valid",
    });
    const res = await callbackPOST(req);
    expect(res.status).toBe(413);
    expect(req.bodyUsed).toBe(false);
    expect(mockedValidate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      JSON.stringify({ event: "saml_callback_failed", reason: "body_too_large" }),
    );
  });

  it("413s an oversize chunked body with no Content-Length, aborting the read", async () => {
    // 1 MiB in 16 KiB chunks, no Content-Length: the cap must cut the handler's
    // read off part-way and cancel the stream rather than drain it.
    const chunk = new TextEncoder().encode("A".repeat(16 * 1024));
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("SAMLResponse="));
      },
      pull(controller) {
        if (sent >= 64) return controller.close();
        sent++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new NextRequest(CALLBACK, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    });
    const res = await callbackPOST(req);
    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(64);
    expect(mockedValidate).not.toHaveBeenCalled();
  });

  it("parses a large but under-cap body unchanged", async () => {
    mockedValidate.mockResolvedValue({ ok: true, cwid: "abc1234", assertion: ASSERTION });
    const samlResponse = "P".repeat(200 * 1024);
    const body = new URLSearchParams({
      SAMLResponse: samlResponse,
      RelayState: "/edit/foo",
    }).toString();
    const req = new NextRequest(CALLBACK, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "content-length": String(body.length),
      },
      body,
    });
    const res = await callbackPOST(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/edit/foo");
    expect(mockedValidate).toHaveBeenCalledWith(samlResponse);
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
