/**
 * POST /api/edit/orcid — the Identifiers & Profiles write. Pins the two-step
 * order (ReciterDB `admin_orcid` first, fail closed; then `scholar.orcid` + audit),
 * the checksum gate, and the `authorizeOverviewWrite` boundary. Mirrors the
 * appointment-visibility route test's mock seams.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockScholarFindUnique,
  mockScholarProxyFindUnique,
  mockDivisionMembershipFindMany,
  mockDivisionFindMany,
  mockUnitAdminFindMany,
  mockTransaction,
  mockTxScholarUpdate,
  mockTxCandidateDeleteMany,
  mockTxExecuteRaw,
  mockReflectOverviewEdit,
  mockReciterQuery,
  mockWithReciterConnection,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarProxyFindUnique: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxScholarUpdate: vi.fn(),
  mockTxCandidateDeleteMany: vi.fn(),
  mockTxExecuteRaw: vi.fn(),
  mockReflectOverviewEdit: vi.fn(),
  mockReciterQuery: vi.fn(),
  mockWithReciterConnection: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEditSession,
  impersonationActive: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(async () => {
    const s = await mockGetEditSession();
    return s ? { cwid: s.cwid, iat: 0, exp: 0 } : null;
  }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findUnique: mockScholarFindUnique },
      scholarProxy: { findUnique: mockScholarProxyFindUnique },
      divisionMembership: { findMany: mockDivisionMembershipFindMany },
      division: { findMany: mockDivisionFindMany },
      unitAdmin: { findMany: mockUnitAdminFindMany },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({ reflectOverviewEdit: mockReflectOverviewEdit }));
vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection: mockWithReciterConnection }));

import { POST } from "@/app/api/edit/orcid/route";

// The route is gated on SELF_EDIT_ORCID_SUGGESTION (one kill switch for the tab,
// its write, and the suggestion); on for every case but the gate test.
process.env.SELF_EDIT_ORCID_SUGGESTION = "on";

const SELF = { cwid: "self01", isSuperuser: false, isCommsSteward: false };
const OTHER = { cwid: "other9", isSuperuser: false, isCommsSteward: false };
const ADMIN = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };
const fakeTx = {
  scholar: { update: mockTxScholarUpdate },
  orcidCandidate: { deleteMany: mockTxCandidateDeleteMany },
  $executeRaw: mockTxExecuteRaw,
};
const ID = "0000-0002-1825-0097";

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/orcid", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(SELF);
  mockScholarFindUnique.mockResolvedValue({ cwid: "self01", slug: "self01-slug", orcid: null });
  mockScholarProxyFindUnique.mockResolvedValue(null);
  mockDivisionMembershipFindMany.mockResolvedValue([]);
  mockDivisionFindMany.mockResolvedValue([]);
  mockUnitAdminFindMany.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockTxScholarUpdate.mockResolvedValue({});
  mockTxExecuteRaw.mockResolvedValue(1);
  mockReflectOverviewEdit.mockResolvedValue(undefined);
  mockReciterQuery.mockResolvedValue({ affectedRows: 1 });
  mockWithReciterConnection.mockImplementation(async (fn: (conn: { query: typeof mockReciterQuery }) => unknown) =>
    fn({ query: mockReciterQuery }),
  );
});

describe("POST /api/edit/orcid", () => {
  it("404 when the flag is off, before reading the session", async () => {
    process.env.SELF_EDIT_ORCID_SUGGESTION = "off";
    try {
      const res = await POST(post({ cwid: "self01", orcid: ID }));
      expect(res.status).toBe(404);
      expect(mockGetEditSession).not.toHaveBeenCalled();
    } finally {
      process.env.SELF_EDIT_ORCID_SUGGESTION = "on";
    }
  });

  it("400 on a cwid that is not a cwid", async () => {
    const res = await POST(post({ cwid: "Not A Cwid!", orcid: ID }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_cwid");
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated; nothing written anywhere", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await POST(post({ cwid: "self01", orcid: ID }));
    expect(res.status).toBe(401);
    expect(mockWithReciterConnection).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400 on a wrong check digit, before any lookup or write", async () => {
    const res = await POST(post({ cwid: "self01", orcid: "0000-0002-1825-0098" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_orcid");
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
    expect(mockWithReciterConnection).not.toHaveBeenCalled();
  });

  it("self MAY set their own iD: admin_orcid upsert, then scholar.orcid + one audit row, then profile reflection; the URL form is normalized", async () => {
    const res = await POST(post({ cwid: "self01", orcid: "https://orcid.org/0000000218250097", confirmedSuggestion: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).orcid).toBe(ID);
    expect(mockReciterQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO admin_orcid"), ["self01", ID]);
    expect(mockTxScholarUpdate).toHaveBeenCalledWith({ where: { cwid: "self01" }, data: { orcid: ID } });
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1);
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args[1]).toBe("self01"); // actor_cwid
    expect(args.some((v) => typeof v === "string" && v.includes("confirmed_suggestion"))).toBe(true);
    expect(mockReflectOverviewEdit).toHaveBeenCalledWith("self01-slug");
    // Order: ReciterDB before the SPS transaction.
    expect(mockWithReciterConnection.mock.invocationCallOrder[0]).toBeLessThan(mockTransaction.mock.invocationCallOrder[0]);
  });

  it("orcid: null REMOVES: admin_orcid DELETE, scholar.orcid null, the rpm_admin mirror row dropped, one audit row", async () => {
    mockScholarFindUnique.mockResolvedValue({ cwid: "self01", slug: "self01-slug", orcid: ID });
    const res = await POST(post({ cwid: "self01", orcid: null }));
    expect(res.status).toBe(200);
    expect((await res.json()).orcid).toBeNull();
    expect(mockReciterQuery).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM admin_orcid"), ["self01"]);
    expect(mockReciterQuery).not.toHaveBeenCalledWith(expect.stringContaining("INSERT"), expect.anything());
    expect(mockTxScholarUpdate).toHaveBeenCalledWith({ where: { cwid: "self01" }, data: { orcid: null } });
    expect(mockTxCandidateDeleteMany).toHaveBeenCalledWith({ where: { cwid: "self01", source: "rpm_admin" } });
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1);
    expect(mockReflectOverviewEdit).toHaveBeenCalledWith("self01-slug");
  });

  it("a set never touches the rpm_admin mirror row", async () => {
    const res = await POST(post({ cwid: "self01", orcid: ID }));
    expect(res.status).toBe(200);
    expect(mockTxCandidateDeleteMany).not.toHaveBeenCalled();
  });

  it("400 on a non-string, non-null orcid; nothing written", async () => {
    const res = await POST(post({ cwid: "self01", orcid: 123 }));
    expect(res.status).toBe(400);
    expect(mockWithReciterConnection).not.toHaveBeenCalled();
  });

  it("502 and NO SPS write when ReciterDB is unreachable (fail closed)", async () => {
    mockWithReciterConnection.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await POST(post({ cwid: "self01", orcid: ID }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("reciter_unavailable");
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockReflectOverviewEdit).not.toHaveBeenCalled();
  });

  it("another scholar MAY NOT set someone else's iD (403, nothing written); a superuser may", async () => {
    mockGetEditSession.mockResolvedValue(OTHER);
    const denied = await POST(post({ cwid: "self01", orcid: ID }));
    expect(denied.status).toBe(403);
    expect(mockWithReciterConnection).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();

    mockGetEditSession.mockResolvedValue(ADMIN);
    const allowed = await POST(post({ cwid: "self01", orcid: ID }));
    expect(allowed.status).toBe(200);
    expect((mockTxExecuteRaw.mock.calls[0] as unknown[])[1]).toBe("adm001"); // the admin is the actor
  });

  it("404 for an unknown scholar, before authorization and writes", async () => {
    mockScholarFindUnique.mockResolvedValue(null);
    const res = await POST(post({ cwid: "nobody", orcid: ID }));
    expect(res.status).toBe(404);
    expect(mockWithReciterConnection).not.toHaveBeenCalled();
  });
});
