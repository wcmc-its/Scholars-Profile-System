/**
 * #779 / scholar-proxy-spec.md — /api/edit/proxy (grant + revoke).
 *
 * Each test maps to a row in the SPEC § Edge-case test table or a threat:
 *  - Superuser-on-behalf grant → 200, audit actor = superuser (edge 19).
 *  - A proxy can never grant → 403 not_self (edge 15 / CD-2).
 *  - D3 grant-time conflict (Amendment 4 D4 narrowed to superuser-only): a
 *    scholar / unit_admin candidate now succeeds; only a superuser candidate →
 *    403 proxy_ineligible, opaque (CD-3 / CD-6).
 *  - Cross-origin → 403 (CD-4).
 *  - Grant while impersonating → 403 impersonation_block (edge 18 / IS-10).
 *  - Grant for a soft-deleted scholar → 400 scholar_not_found (edge 20).
 *  - Revoke non-existent → 200 no-op, no tx (edge 24).
 *  - Cardinality cap → 400 proxy_limit_reached (edge 28 / D5).
 *  - Self-proxy → 400 cannot_proxy_self (edge 29).
 *  - Case/whitespace CWID normalized before write (edge 25 / PE-04).
 *  - grantedBy = realCwid; audit impersonated_cwid = null.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockGetSession,
  mockIsSuperuser,
  mockImpersonationActive,
  mockScholarFindUnique,
  mockUnitAdminFindFirst,
  mockProxyFindUnique,
  mockProxyCount,
  mockTransaction,
  mockExecuteRaw,
  mockTxProxyUpsert,
  mockTxProxyDelete,
  mockNotify,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockIsSuperuser: vi.fn(),
  mockImpersonationActive: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockUnitAdminFindFirst: vi.fn(),
  mockProxyFindUnique: vi.fn(),
  mockProxyCount: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockTxProxyUpsert: vi.fn(),
  mockTxProxyDelete: vi.fn(),
  mockNotify: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({
  getEditSession: mockGetEditSession,
  isSuperuser: mockIsSuperuser, // the D3 superuser leg in checkProxyConflictingRole
}));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEditSession,
  impersonationActive: mockImpersonationActive,
}));
vi.mock("@/lib/auth/session-server", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findUnique: mockScholarFindUnique },
      unitAdmin: { findFirst: mockUnitAdminFindFirst },
      scholarProxy: { findUnique: mockProxyFindUnique, count: mockProxyCount },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/proxy-notification", () => ({ notifyProxyGrant: mockNotify }));

import { POST } from "@/app/api/edit/proxy/route";

const SCHOLAR = "ras2022";
const PROXY = "bec4010";

const fakeTx = {
  scholarProxy: { upsert: mockTxProxyUpsert, delete: mockTxProxyDelete },
  $executeRaw: mockExecuteRaw,
};

function post(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/edit/proxy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Default: a non-impersonating actor `cwid`, optionally a superuser. */
function actingAs(cwid: string, isSuperuser = false) {
  mockGetEditSession.mockResolvedValue({ cwid, isSuperuser });
  mockGetSession.mockResolvedValue({ cwid, iat: 0, exp: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockImpersonationActive.mockReturnValue(false);
  mockIsSuperuser.mockResolvedValue(false); // D3 superuser leg: clean by default
  // scholar.findUnique routes by cwid: the scholar exists & is live; the proxy
  // is NOT a scholar (null) by default.
  mockScholarFindUnique.mockImplementation(async ({ where }: { where: { cwid: string } }) => {
    if (where.cwid === SCHOLAR) {
      return { deletedAt: null, preferredName: "Rahul Sharma", email: "ras2022@med.cornell.edu" };
    }
    return null; // the proxy has no Scholar row
  });
  mockUnitAdminFindFirst.mockResolvedValue(null); // D3 unit-admin leg: clean
  mockProxyFindUnique.mockResolvedValue(null); // no existing grant
  mockProxyCount.mockResolvedValue(0); // under cap
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockExecuteRaw.mockResolvedValue(1);
  mockTxProxyUpsert.mockResolvedValue({});
  mockTxProxyDelete.mockResolvedValue({});
  actingAs(SCHOLAR); // default: the scholar self-assigns
});

describe("/api/edit/proxy — grant", () => {
  it("scholar self-assigns a clean proxy → 200, grantedBy = scholar, audit impersonated null", async () => {
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: PROXY, action: "grant" }));
    expect(res.status).toBe(200);
    expect(mockTxProxyUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { scholarCwid: SCHOLAR, proxyCwid: PROXY, grantedBy: SCHOLAR },
      }),
    );
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ proxyCwid: PROXY, scholarCwid: SCHOLAR, byScholarSelf: true }),
    );
  });

  it("superuser grants on the scholar's behalf → 200, grantedBy = superuser (edge 19)", async () => {
    actingAs("sup001", true);
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: PROXY, action: "grant" }));
    expect(res.status).toBe(200);
    expect(mockTxProxyUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ grantedBy: "sup001" }) }),
    );
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ byScholarSelf: false }));
  });

  it("a proxy/other non-superuser cannot grant → 403 not_self (edge 15 / CD-2)", async () => {
    actingAs(PROXY); // the proxy themselves tries to grant
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: "zzz9", action: "grant" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("candidate IS a scholar → now allowed (Amendment 4 D4): 200, grant committed", async () => {
    // The proxy candidate is itself an active scholar — no longer a conflict.
    mockScholarFindUnique.mockImplementation(async ({ where }: { where: { cwid: string } }) => {
      if (where.cwid === SCHOLAR) {
        return { deletedAt: null, preferredName: "Rahul Sharma", email: "x@y" };
      }
      return { deletedAt: null }; // the proxy candidate is itself an active scholar
    });
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: PROXY, action: "grant" }));
    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalled();
    expect(mockTxProxyUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { scholarCwid: SCHOLAR, proxyCwid: PROXY, grantedBy: SCHOLAR } }),
    );
  });

  it("candidate holds a unit_admin row → now allowed (Amendment 4 D4): 200, grant committed", async () => {
    mockUnitAdminFindFirst.mockResolvedValue({ cwid: PROXY });
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: PROXY, action: "grant" }));
    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalled();
  });

  it("candidate IS a superuser (live leg, not deferred) → 403 proxy_ineligible (the one kept leg / CD-3)", async () => {
    mockIsSuperuser.mockResolvedValue(true);
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: PROXY, action: "grant" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "proxy_ineligible" });
    expect(mockIsSuperuser).toHaveBeenCalledWith(PROXY);
  });

  it("grant while impersonating → 403 impersonation_block (edge 18 / IS-10)", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: SCHOLAR, isSuperuser: false }); // effective = target
    mockGetSession.mockResolvedValue({
      cwid: "sup001",
      impersonating: { targetCwid: SCHOLAR, startedAt: 0 },
      iat: 0,
      exp: 0,
    });
    mockImpersonationActive.mockReturnValue(true);
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: PROXY, action: "grant" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "impersonation_block" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("cross-origin → 403 before any DB read (CD-4)", async () => {
    const res = await POST(
      post({ scholarCwid: SCHOLAR, proxyCwid: PROXY, action: "grant" }, { "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(403);
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
  });

  it("grant for a soft-deleted scholar → 400 scholar_not_found (edge 20)", async () => {
    mockScholarFindUnique.mockImplementation(async ({ where }: { where: { cwid: string } }) =>
      where.cwid === SCHOLAR ? { deletedAt: new Date(), preferredName: "x", email: "x@y" } : null,
    );
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: PROXY, action: "grant" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "scholar_not_found" });
  });

  it("at the per-scholar cap → 400 proxy_limit_reached (edge 28 / D5)", async () => {
    mockProxyCount.mockResolvedValue(10);
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: PROXY, action: "grant" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "proxy_limit_reached" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("self-proxy → 400 cannot_proxy_self (edge 29)", async () => {
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: SCHOLAR, action: "grant" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "cannot_proxy_self" });
  });

  it("normalizes a mixed-case/whitespace CWID before write (edge 25 / PE-04)", async () => {
    const res = await POST(post({ scholarCwid: " RAS2022 ", proxyCwid: "BEC4010", action: "grant" }));
    expect(res.status).toBe(200);
    expect(mockTxProxyUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { scholarCwid: SCHOLAR, proxyCwid: PROXY, grantedBy: SCHOLAR } }),
    );
  });
});

describe("/api/edit/proxy — revoke", () => {
  it("revoke of a non-existent grant → 200 no-op, no transaction (edge 24)", async () => {
    mockProxyFindUnique.mockResolvedValue(null);
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: PROXY, action: "revoke" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("revoke of an existing grant → delete + audit in one transaction; no notification", async () => {
    mockProxyFindUnique.mockResolvedValue({ grantedBy: SCHOLAR });
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: PROXY, action: "revoke" }));
    expect(res.status).toBe(200);
    expect(mockTxProxyDelete).toHaveBeenCalledOnce();
    expect(mockExecuteRaw).toHaveBeenCalledOnce();
    expect(mockNotify).not.toHaveBeenCalled(); // silent on revoke (D2)
  });

  it("a non-superuser, non-scholar cannot revoke → 403 not_self (CD-2)", async () => {
    actingAs(PROXY);
    mockProxyFindUnique.mockResolvedValue({ grantedBy: SCHOLAR });
    const res = await POST(post({ scholarCwid: SCHOLAR, proxyCwid: PROXY, action: "revoke" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
    expect(mockTxProxyDelete).not.toHaveBeenCalled();
  });
});
