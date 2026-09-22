/**
 * POST /api/edit/orcid — the Identifiers & Profiles write. Pins the one SPS
 * transaction (`scholar.orcid` + `orcid_confirmed_at`, the `orcid_dismissal`
 * pair, the audit row), that nothing is written to ReciterDB, the checksum gate,
 * and the `authorizeOverviewWrite` boundary. Mirrors the appointment-visibility
 * route test's mock seams.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
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
  mockTxCandidateFindFirst,
  mockTxDismissalUpsert,
  mockTxDismissalDeleteMany,
  mockTxExecuteRaw,
  mockReflectOverviewEdit,
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
  mockTxCandidateFindFirst: vi.fn(),
  mockTxDismissalUpsert: vi.fn(),
  mockTxDismissalDeleteMany: vi.fn(),
  mockTxExecuteRaw: vi.fn(),
  mockReflectOverviewEdit: vi.fn(),
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
// Mocked only so a regression that re-imports it is caught: the route must never call it.
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
  orcidCandidate: { deleteMany: mockTxCandidateDeleteMany, findFirst: mockTxCandidateFindFirst },
  orcidDismissal: { upsert: mockTxDismissalUpsert, deleteMany: mockTxDismissalDeleteMany },
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
  mockTxCandidateFindFirst.mockResolvedValue(null);
  mockTxDismissalUpsert.mockResolvedValue({});
  mockTxDismissalDeleteMany.mockResolvedValue({ count: 0 });
  mockTxExecuteRaw.mockResolvedValue(1);
  mockReflectOverviewEdit.mockResolvedValue(undefined);
});

afterEach(() => {
  // No path through the route touches ReciterDB (`admin_orcid` is dead).
  expect(mockWithReciterConnection).not.toHaveBeenCalled();
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
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400 on a wrong check digit, before any lookup or write", async () => {
    const res = await POST(post({ cwid: "self01", orcid: "0000-0002-1825-0098" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_orcid");
    expect(mockScholarFindUnique).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("self MAY set their own iD: scholar.orcid + orcid_confirmed_at, the pair's dismissal deleted, one audit row, then profile reflection; the URL form is normalized", async () => {
    const before = Date.now();
    const res = await POST(post({ cwid: "self01", orcid: "https://orcid.org/0000000218250097", confirmedSuggestion: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).orcid).toBe(ID);
    expect(mockTxScholarUpdate).toHaveBeenCalledTimes(1);
    const { where, data } = mockTxScholarUpdate.mock.calls[0][0] as {
      where: { cwid: string };
      data: { orcid: string | null; orcidConfirmedAt: Date | null };
    };
    expect(where).toEqual({ cwid: "self01" });
    expect(data.orcid).toBe(ID);
    expect(data.orcidConfirmedAt).toBeInstanceOf(Date);
    expect(data.orcidConfirmedAt!.getTime()).toBeGreaterThanOrEqual(before);
    // Re-confirming an iD the person once removed un-dismisses exactly that pair.
    expect(mockTxDismissalDeleteMany).toHaveBeenCalledWith({ where: { cwid: "self01", orcid: ID } });
    expect(mockTxDismissalUpsert).not.toHaveBeenCalled();
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1);
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args[1]).toBe("self01"); // actor_cwid
    expect(args.some((v) => typeof v === "string" && v.includes("confirmed_suggestion"))).toBe(true);
    expect(mockReflectOverviewEdit).toHaveBeenCalledWith("self01-slug");
  });

  it("orcid: null REMOVES: scholar.orcid AND orcid_confirmed_at nulled, the rpm_admin mirror row dropped, the removed iD dismissed, one audit row", async () => {
    // The removed iD is on the rpm_admin mirror row, NOT scholar.orcid (NULL for WCM).
    mockTxCandidateFindFirst.mockResolvedValue({ orcid: ID });
    const res = await POST(post({ cwid: "self01", orcid: null }));
    expect(res.status).toBe(200);
    expect((await res.json()).orcid).toBeNull();
    expect(mockTxScholarUpdate).toHaveBeenCalledWith({
      where: { cwid: "self01" },
      data: { orcid: null, orcidConfirmedAt: null },
    });
    expect(mockTxCandidateDeleteMany).toHaveBeenCalledWith({ where: { cwid: "self01", source: "rpm_admin" } });
    // The dismissal is what stops the nightly mirror / Identity import bringing it back.
    expect(mockTxDismissalUpsert).toHaveBeenCalledTimes(1);
    expect(mockTxDismissalUpsert).toHaveBeenCalledWith({
      where: { cwid_orcid: { cwid: "self01", orcid: ID } },
      create: { cwid: "self01", orcid: ID },
      update: {},
    });
    expect(mockTxDismissalDeleteMany).not.toHaveBeenCalled();
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1);
    // The audit row names the iD that went (before) and marks the remove (after).
    const args = mockTxExecuteRaw.mock.calls[0] as unknown[];
    expect(args.some((v) => typeof v === "string" && v.includes(ID))).toBe(true);
    expect(args.some((v) => typeof v === "string" && v.includes('"removed":true'))).toBe(true);
    expect(mockReflectOverviewEdit).toHaveBeenCalledWith("self01-slug");
  });

  it("a remove of an iD held on scholar.orcid dismisses THAT iD, even when an rpm_admin row carries another", async () => {
    const OTHER_ID = "0000-0000-0000-001X"; // synthetic, checksum-valid
    mockScholarFindUnique.mockResolvedValue({ cwid: "self01", slug: "self01-slug", orcid: OTHER_ID });
    mockTxCandidateFindFirst.mockResolvedValue({ orcid: ID });
    const res = await POST(post({ cwid: "self01", orcid: null }));
    expect(res.status).toBe(200);
    expect(mockTxDismissalUpsert).toHaveBeenCalledTimes(1);
    expect(mockTxDismissalUpsert.mock.calls[0][0]).toMatchObject({
      where: { cwid_orcid: { cwid: "self01", orcid: OTHER_ID } },
    });
  });

  it("a remove with nothing on file writes no dismissal (but still nulls both columns and audits)", async () => {
    const res = await POST(post({ cwid: "self01", orcid: null }));
    expect(res.status).toBe(200);
    expect(mockTxScholarUpdate).toHaveBeenCalledWith({
      where: { cwid: "self01" },
      data: { orcid: null, orcidConfirmedAt: null },
    });
    expect(mockTxDismissalUpsert).not.toHaveBeenCalled();
    expect(mockTxDismissalDeleteMany).not.toHaveBeenCalled();
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("500 write_failed when the transaction throws; the profile is not re-reflected", async () => {
    mockTransaction.mockRejectedValue(new Error("deadlock"));
    const res = await POST(post({ cwid: "self01", orcid: ID }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("write_failed");
    expect(mockReflectOverviewEdit).not.toHaveBeenCalled();
  });

  it("a set never touches the rpm_admin mirror row", async () => {
    const res = await POST(post({ cwid: "self01", orcid: ID }));
    expect(res.status).toBe(200);
    expect(mockTxCandidateDeleteMany).not.toHaveBeenCalled();
  });

  it("400 on a non-string, non-null orcid; nothing written", async () => {
    const res = await POST(post({ cwid: "self01", orcid: 123 }));
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("another scholar MAY NOT set someone else's iD (403, nothing written); a superuser may", async () => {
    mockGetEditSession.mockResolvedValue(OTHER);
    const denied = await POST(post({ cwid: "self01", orcid: ID }));
    expect(denied.status).toBe(403);
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
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
