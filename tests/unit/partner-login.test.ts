// @vitest-environment node
// Partner (Cornell Ithaca) login, step 1 of the Ithaca login plan: keyed on the
// full eppn, invisible to every default session reader, 403 on gated paths,
// admitted only with a live Ithaca roster row.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/saml", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/auth/saml")>()),
  validateSamlResponse: vi.fn(),
}));
vi.mock("@/lib/auth/saml-assertion-store", () => ({
  markAssertionConsumed: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { count: vi.fn() },
      scholarIdentityLink: { findMany: vi.fn() },
    },
  },
}));

import type { Profile } from "@node-saml/node-saml";
import { NextRequest } from "next/server";
import { extractPartnerEppn, validateSamlResponse } from "@/lib/auth/saml";
import { markAssertionConsumed } from "@/lib/auth/saml-assertion-store";
import { createSessionCookie, readSessionValue } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { readSessionValue as readAny } from "@/lib/auth/session";
import { proxy } from "@/proxy";
import { POST as callbackPOST } from "@/app/api/auth/saml/callback/route";

process.env.SESSION_COOKIE_SECRET = "test-session-secret-0123456789-0123456789";

const EPPN = "urn:oid:1.3.6.1.4.1.5923.1.1.1.6";
const ORIGIN = "https://scholars.weill.cornell.edu";
const ASSERTION = { id: "assn:_p", expiresAt: new Date(Date.now() + 60_000) };
const profile = (attrs: Record<string, unknown>) =>
  ({ issuer: "x", nameID: "transient", nameIDFormat: "x", ...attrs }) as Profile;

beforeEach(() => {
  vi.stubEnv("ITHACA_LOGIN", "on");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(markAssertionConsumed).mockResolvedValue({ duplicate: false });
  vi.mocked(db.read.scholarIdentityLink.findMany).mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("extractPartnerEppn", () => {
  it("returns the full lower-cased eppn for a cornell.edu scope", () => {
    expect(extractPartnerEppn(profile({ [EPPN]: "ZQ99@Cornell.EDU" }), EPPN)).toBe(
      "zq99@cornell.edu",
    );
  });

  it("is off unless ITHACA_LOGIN is exactly on", () => {
    vi.stubEnv("ITHACA_LOGIN", "true");
    expect(extractPartnerEppn(profile({ [EPPN]: "zq99@cornell.edu" }), EPPN)).toBeNull();
  });

  it("ignores WCM, NYP, look-alike and malformed eppns", () => {
    for (const v of [
      "abc1234@med.cornell.edu",
      "paa2013@nyp.org",
      "zq99@evil-cornell.edu",
      "@cornell.edu",
      "a@b@cornell.edu",
    ]) {
      expect(extractPartnerEppn(profile({ [EPPN]: v }), EPPN)).toBeNull();
    }
  });
});

describe("session readers", () => {
  it("hide a partner session unless the reader opts in", async () => {
    const { value } = await createSessionCookie("zq99@cornell.edu");
    expect(await readSessionValue(value)).toBeNull();
    expect((await readSessionValue(value, { allowPartner: true }))?.cwid).toBe(
      "zq99@cornell.edu",
    );
  });

  it("still return a WCM session", async () => {
    const { value } = await createSessionCookie("abc1234");
    expect((await readSessionValue(value))?.cwid).toBe("abc1234");
  });
});

describe("proxy", () => {
  async function partnerRequest(path: string): Promise<NextRequest> {
    const c = await createSessionCookie("zq99@cornell.edu");
    return new NextRequest(`${ORIGIN}${path}`, {
      headers: { cookie: `${c.name}=${c.value}` },
    });
  }

  it("403s a partner session on gated paths, never redirecting to SSO", async () => {
    for (const path of ["/edit", "/edit/scholar/zq99", "/edit/cornellx", "/api/edit/field", "/api/edit/orcid"]) {
      const res = await proxy(await partnerRequest(path));
      expect(res.status).toBe(403);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("lets a partner session reach exactly its allowlisted paths", async () => {
    for (const path of ["/edit/cornell", "/api/edit/orcid/connect", "/api/edit/orcid/callback"]) {
      const res = await proxy(await partnerRequest(path));
      expect(res.status).not.toBe(403);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("passes a partner session through on public pages", async () => {
    const res = await proxy(await partnerRequest("/"));
    expect(res.status).not.toBe(403);
  });
});

describe("SAML callback", () => {
  function callback(): Promise<Response> {
    vi.mocked(validateSamlResponse).mockResolvedValue({
      ok: true,
      cwid: "zq99@cornell.edu",
      assertion: ASSERTION,
    });
    return callbackPOST(
      new NextRequest(`${ORIGIN}/api/auth/saml/callback`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ SAMLResponse: "x", RelayState: "/edit" }).toString(),
      }),
    );
  }

  it("admits a NetID with a live Ithaca roster row and lands on /edit/cornell", async () => {
    vi.mocked(db.read.scholar.count).mockResolvedValue(1);
    const res = await callback();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/edit/cornell");
    expect(await sessionCwidOf(res)).toBe("zq99@cornell.edu");
    expect(db.read.scholar.count).toHaveBeenCalledWith({
      where: { cwid: "zq99", campus: "ithaca", deletedAt: null },
    });
  });

  async function sessionCwidOf(res: Response): Promise<string | undefined> {
    const raw = res.headers.get("set-cookie")!.split(";")[0];
    const value = raw.slice(raw.indexOf("=") + 1);
    return (await readAny(value, { allowPartner: true }))?.cwid;
  }

  it("signs a joint-appointment NetID in as its known WCM CWID, honoring RelayState", async () => {
    vi.mocked(db.read.scholarIdentityLink.findMany).mockResolvedValue([
      { cwid: "abc1234" },
    ] as never);
    const res = await callback();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/edit");
    expect(await sessionCwidOf(res)).toBe("abc1234");
    expect(db.read.scholarIdentityLink.findMany).toHaveBeenCalledWith({
      where: { netid: "zq99", band: "known" },
      select: { cwid: true },
    });
    expect(db.read.scholar.count).not.toHaveBeenCalled();
  });

  it("never guesses between two known CWIDs: falls back to the Ithaca session", async () => {
    vi.mocked(db.read.scholarIdentityLink.findMany).mockResolvedValue([
      { cwid: "abc1234" },
      { cwid: "def5678" },
    ] as never);
    vi.mocked(db.read.scholar.count).mockResolvedValue(1);
    const res = await callback();
    expect(res.headers.get("location")).toBe("/edit/cornell");
    expect(await sessionCwidOf(res)).toBe("zq99@cornell.edu");
  });

  it("refuses ambiguity with no Ithaca row", async () => {
    vi.mocked(db.read.scholarIdentityLink.findMany).mockResolvedValue([
      { cwid: "abc1234" },
      { cwid: "def5678" },
    ] as never);
    vi.mocked(db.read.scholar.count).mockResolvedValue(0);
    expect((await callback()).status).toBe(403);
  });

  it("refuses a NetID without one, and mints no cookie", async () => {
    vi.mocked(db.read.scholar.count).mockResolvedValue(0);
    const res = await callback();
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("fails closed when the roster lookup errors", async () => {
    vi.mocked(db.read.scholar.count).mockRejectedValue(new Error("db down"));
    const res = await callback();
    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
