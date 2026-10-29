/**
 * #3115 "Connect your ORCID iD": the pure helpers in `lib/edit/orcid-connect.ts`
 * and the connect / callback routes — genuine-self gate, the state cookie, the
 * denied / failed paths that write nothing, and the one transaction on success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockImpersonationActive,
  mockScholarFindUnique,
  mockTransaction,
  mockTxScholarFindUnique,
  mockTxScholarUpdate,
  mockTxCandidateFindMany,
  mockTxDismissalUpsert,
  mockTxDismissalDeleteMany,
  mockTxAuthUpsert,
  mockTxExecuteRaw,
  mockReflectOverviewEdit,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockImpersonationActive: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxScholarFindUnique: vi.fn(),
  mockTxScholarUpdate: vi.fn(),
  mockTxCandidateFindMany: vi.fn(),
  mockTxDismissalUpsert: vi.fn(),
  mockTxDismissalDeleteMany: vi.fn(),
  mockTxAuthUpsert: vi.fn(),
  mockTxExecuteRaw: vi.fn(),
  mockReflectOverviewEdit: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({
  getEditSession: mockGetEditSession,
  isSuperuser: vi.fn(async () => false),
}));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEditSession,
  impersonationActive: mockImpersonationActive,
}));
vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(async () => {
    const s = await mockGetEditSession();
    return s ? { cwid: s.cwid, iat: 0, exp: 0, impersonating: { targetCwid: "other9" } } : null;
  }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: { scholar: { findUnique: mockScholarFindUnique } },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({ reflectOverviewEdit: mockReflectOverviewEdit }));

import { GET as CONNECT } from "@/app/api/edit/orcid/connect/route";
import { GET as CALLBACK } from "@/app/api/edit/orcid/callback/route";
import {
  authorizeUrl,
  decryptToken,
  encryptToken,
  orcidConnectConfig,
  stateMatches,
  STATE_COOKIE,
} from "@/lib/edit/orcid-connect";

const KEY = Buffer.alloc(32, 7).toString("base64");
const ENV = {
  ORCID_CONNECT: "on",
  ORCID_CONNECT_BASE: "https://sandbox.orcid.org",
  ORCID_CONNECT_CLIENT_ID: "APP-TEST",
  ORCID_CONNECT_CLIENT_SECRET: "shh",
  ORCID_CONNECT_TOKEN_KEY: KEY,
  SITE_URL: "https://scholars.example.edu",
};
const ID = "0000-0002-1825-0097";
const OLD_ID = "0000-0000-0000-001X";
const fakeTx = {
  scholar: { findUnique: mockTxScholarFindUnique, update: mockTxScholarUpdate },
  orcidCandidate: { findMany: mockTxCandidateFindMany },
  orcidDismissal: { upsert: mockTxDismissalUpsert, deleteMany: mockTxDismissalDeleteMany },
  orcidAuthentication: { upsert: mockTxAuthUpsert },
  $executeRaw: mockTxExecuteRaw,
};

function callback(query: string, state: string | null = "s1"): NextRequest {
  return new NextRequest(`https://scholars.example.edu/api/edit/orcid/callback?${query}`, {
    headers: state ? { cookie: `${STATE_COOKIE}=${state}` } : {},
  });
}
const tokenOk = () =>
  new Response(
    JSON.stringify({
      orcid: ID,
      name: "Test Person",
      access_token: "tok-123",
      scope: "/authenticate",
      expires_in: 631138518,
    }),
    { status: 200 },
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.assign(process.env, ENV);
  mockGetEditSession.mockResolvedValue({
    cwid: "self01",
    isSuperuser: false,
    isCommsSteward: false,
  });
  mockImpersonationActive.mockReturnValue(false);
  mockScholarFindUnique.mockResolvedValue({ cwid: "self01", slug: "self01-slug" });
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockTxScholarFindUnique.mockResolvedValue({ orcid: OLD_ID });
  mockTxCandidateFindMany.mockResolvedValue([{ orcid: OLD_ID }]);
  mockTxExecuteRaw.mockResolvedValue(1);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => tokenOk()),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("orcid-connect helpers", () => {
  it("config needs every piece, a 32-byte key and an ORCID host", () => {
    expect(orcidConnectConfig(ENV)?.redirectUri).toBe(
      "https://scholars.example.edu/api/edit/orcid/callback",
    );
    expect(orcidConnectConfig(ENV)?.sandbox).toBe(true);
    expect(orcidConnectConfig({ ...ENV, ORCID_CONNECT_TOKEN_KEY: "c2hvcnQ=" })).toBeNull();
    expect(orcidConnectConfig({ ...ENV, ORCID_CONNECT_BASE: "https://evil.example" })).toBeNull();
    expect(orcidConnectConfig({ ...ENV, ORCID_CONNECT_CLIENT_SECRET: "" })).toBeNull();
  });

  it("authorize URL asks for /authenticate only", () => {
    const u = new URL(authorizeUrl(orcidConnectConfig(ENV)!, "st"));
    expect(u.origin + u.pathname).toBe("https://sandbox.orcid.org/oauth/authorize");
    expect(u.searchParams.get("scope")).toBe("/authenticate");
    expect(u.searchParams.get("state")).toBe("st");
  });

  it("token round-trips and a tampered ciphertext fails", () => {
    const key = Buffer.from(KEY, "base64");
    const enc = encryptToken("tok-123", key);
    expect(enc).not.toContain("tok-123");
    expect(decryptToken(enc, key)).toBe("tok-123");
    const [iv, tag, ct] = enc.split(".");
    expect(() => decryptToken([iv, tag, ct.slice(0, -2) + "AA"].join("."), key)).toThrow();
  });

  it("state must match exactly", () => {
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(stateMatches("abc", "abd")).toBe(false);
    expect(stateMatches(undefined, "abc")).toBe(false);
    expect(stateMatches("abc", null)).toBe(false);
  });
});

describe("GET /api/edit/orcid/connect", () => {
  it("404 when the flag is off", async () => {
    process.env.ORCID_CONNECT = "off";
    expect((await CONNECT()).status).toBe(404);
  });

  it("500 when on but unconfigured", async () => {
    delete process.env.ORCID_CONNECT_CLIENT_ID;
    expect((await CONNECT()).status).toBe(500);
  });

  it("redirects to ORCID and sets the state cookie", async () => {
    const res = await CONNECT();
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe("sandbox.orcid.org");
    expect(res.cookies.get(STATE_COOKIE)?.value).toBe(loc.searchParams.get("state"));
  });

  it("403 under View as: only the person can prove their iD", async () => {
    mockImpersonationActive.mockReturnValue(true);
    vi.mocked((await import("@/lib/auth/superuser")).isSuperuser).mockResolvedValueOnce(true);
    expect((await CONNECT()).status).toBe(403);
  });
});

describe("GET /api/edit/orcid/callback", () => {
  const outcome = (res: Response) =>
    new URL(res.headers.get("location")!).searchParams.get("orcid");

  it("a state mismatch writes nothing", async () => {
    const res = await CALLBACK(callback("code=c&state=s1", "other"));
    expect(outcome(res)).toBe("failed");
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Deny on ORCID's page writes nothing", async () => {
    const res = await CALLBACK(callback("error=access_denied&state=s1"));
    expect(outcome(res)).toBe("denied");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("a failed token exchange writes nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 400 })),
    );
    const res = await CALLBACK(callback("code=c&state=s1"));
    expect(outcome(res)).toBe("failed");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("success: authenticated iD on file, other iDs dismissed, encrypted token stored, audited", async () => {
    const res = await CALLBACK(callback("code=c&state=s1"));
    expect(outcome(res)).toBe("connected");
    expect(res.headers.get("location")).toBe(
      "https://scholars.example.edu/edit?attr=identifiers-profiles&orcid=connected",
    );
    expect(mockTxScholarUpdate).toHaveBeenCalledWith({
      where: { cwid: "self01" },
      data: expect.objectContaining({
        orcid: ID,
        orcidConfirmMethod: "authenticated",
        orcidConfirmedBy: "self01",
      }),
    });
    expect(mockTxDismissalDeleteMany).toHaveBeenCalledWith({
      where: { cwid: "self01", orcid: ID },
    });
    expect(mockTxDismissalUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          cwid: "self01",
          orcid: OLD_ID,
          dismissedBy: "self01",
          reason: "other_confirmed",
          keptOrcid: ID,
        },
      }),
    );
    const stored = mockTxAuthUpsert.mock.calls[0][0].create;
    expect(stored).toMatchObject({ cwid: "self01", orcid: ID, name: "Test Person", sandbox: true });
    expect(stored.accessTokenEnc).not.toContain("tok-123");
    expect(decryptToken(stored.accessTokenEnc, Buffer.from(KEY, "base64"))).toBe("tok-123");
    expect(mockTxExecuteRaw).toHaveBeenCalled();
    expect(mockReflectOverviewEdit).toHaveBeenCalledWith("self01-slug");
  });
});
