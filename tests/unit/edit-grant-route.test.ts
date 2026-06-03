/**
 * #540 Phase 5b — /api/edit/grant.
 *
 *  - Owner grants `curator` within their subtree → 200.
 *  - Owner grants `owner` within their subtree → 200 (owner→owner permitted,
 *    Amendment 1 § A1.4 C).
 *  - Curator tries to grant → 403 authority_violation (T1).
 *  - Out-of-subtree grant by an Owner → 403 scope_violation (T2).
 *  - Superuser grants any role on any unit → 200.
 *  - Revoke uses the same predicate; revoke of a non-existent row → 200 no-op.
 *  - Self-revoke by a non-Superuser → 403 cannot_revoke_self (T7 footgun).
 *  - Unit not found → 400 unit_not_found.
 *  - Audit row records `grant_change` with `target_entity_type` + role.
 *
 * #728 Phase C — the ED-locked gate (§ 2.2 #3 / § 5 MUST-7):
 *  - Non-superuser revoke of a `source LIKE 'ED:%'` row → 403 ed_locked, no write.
 *  - Non-superuser re-grant (role change) of an ED row → 403 ed_locked, no write.
 *  - Superuser override of an ED row → 200 (write proceeds).
 *  - Non-ED ("manual") row is unaffected (regression).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockExecuteRaw,
  mockDepartmentFindUnique,
  mockDivisionFindUnique,
  mockCenterFindUnique,
  mockUnitAdminFindMany,
  mockUnitAdminFindUnique,
  mockTxUnitAdminUpsert,
  mockTxUnitAdminDelete,
  mockReflectUnitChange,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockDepartmentFindUnique: vi.fn(),
  mockDivisionFindUnique: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockUnitAdminFindUnique: vi.fn(),
  mockTxUnitAdminUpsert: vi.fn(),
  mockTxUnitAdminDelete: vi.fn(),
  mockReflectUnitChange: vi.fn(),
}));

// `readEditRequest` resolves identity through the #637 effective-identity seam.
// Drive it from the same `mockGetEditSession` knob (non-impersonating: real ==
// effective, so `actor_cwid` is this cwid and `impersonatedCwid` stays null).
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
      department: { findUnique: mockDepartmentFindUnique },
      division: { findUnique: mockDivisionFindUnique },
      center: { findUnique: mockCenterFindUnique },
      unitAdmin: {
        findMany: mockUnitAdminFindMany,
        findUnique: mockUnitAdminFindUnique,
      },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectUnitChange: mockReflectUnitChange,
}));

import { POST } from "@/app/api/edit/grant/route";

const OWNER = { cwid: "own001", isSuperuser: false };
const CURATOR = { cwid: "cur001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };
const SUPERUSER = { cwid: "sup001", isSuperuser: true };

const fakeTx = {
  unitAdmin: { upsert: mockTxUnitAdminUpsert, delete: mockTxUnitAdminDelete },
  $executeRaw: mockExecuteRaw,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/grant", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(OWNER);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockExecuteRaw.mockResolvedValue(1);
  mockDepartmentFindUnique.mockResolvedValue({ code: "MED", slug: "medicine" });
  mockDivisionFindUnique.mockResolvedValue({
    code: "CARDIO",
    slug: "cardiology",
    deptCode: "MED",
    department: { slug: "medicine" },
  });
  mockCenterFindUnique.mockResolvedValue({ code: "MEYER", slug: "meyer" });
  mockUnitAdminFindMany.mockResolvedValue([
    { entityType: "department", entityId: "MED", role: "owner" },
  ]);
  mockUnitAdminFindUnique.mockResolvedValue(null);
  mockTxUnitAdminUpsert.mockResolvedValue({});
  mockTxUnitAdminDelete.mockResolvedValue({});
});

describe("/api/edit/grant", () => {
  it("Owner grants curator within their subtree", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: "new001",
        role: "curator",
        action: "grant",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxUnitAdminUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          entityType: "department",
          entityId: "MED",
          cwid: "new001",
          role: "curator",
          grantedBy: "own001",
        }),
      }),
    );
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({ unitKind: "department", unitSlug: "medicine" }),
    );
  });

  it("Owner grants owner within their subtree (owner→owner permitted, A1.4 C)", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: "new001",
        role: "owner",
        action: "grant",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("Owner's grant cascades into a child division", async () => {
    const res = await POST(
      post({
        entityType: "division",
        entityId: "CARDIO",
        cwid: "new001",
        role: "curator",
        action: "grant",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("Curator tries to grant → 403 authority_violation (T1)", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "department", entityId: "MED", role: "curator" },
    ]);
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: "new001",
        role: "curator",
        action: "grant",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "authority_violation" });
  });

  it("Out-of-subtree grant → 403 scope_violation (T2)", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: "new001",
        role: "curator",
        action: "grant",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "scope_violation" });
  });

  it("Superuser grants any role on any unit", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(
      post({
        entityType: "center",
        entityId: "MEYER",
        cwid: "new001",
        role: "owner",
        action: "grant",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("Revoke uses the same predicate; revoke of non-existent row → 200 no-op", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: "ghost",
        role: "curator",
        action: "revoke",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("Owner revokes a grant (writes the delete + audit row)", async () => {
    mockUnitAdminFindUnique.mockResolvedValue({
      role: "curator",
      grantedBy: "own001",
      source: "manual",
    });
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: "rev001",
        role: "curator",
        action: "revoke",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxUnitAdminDelete).toHaveBeenCalledOnce();
    expect(mockExecuteRaw).toHaveBeenCalledOnce();
  });

  it("Self-revoke by a non-Superuser → 403 cannot_revoke_self (T7 footgun)", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: OWNER.cwid,
        role: "owner",
        action: "revoke",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "cannot_revoke_self" });
  });

  it("Superuser self-revoke is allowed (backstop)", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockUnitAdminFindUnique.mockResolvedValue({
      role: "owner",
      grantedBy: SUPERUSER.cwid,
      source: "manual",
    });
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: SUPERUSER.cwid,
        role: "owner",
        action: "revoke",
      }),
    );
    expect(res.status).toBe(200);
  });

  // ── #728 Phase C — ED-locked gate (§ 2.2 #3 / § 5 MUST-7) ──────────────────

  it("Non-superuser revoke of an ED row → 403 ed_locked (no write)", async () => {
    // OWNER (non-superuser) is the default session; they own MED.
    mockUnitAdminFindUnique.mockResolvedValue({
      role: "curator",
      grantedBy: "ED-ETL",
      source: "ED:DA",
    });
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: "ed0001",
        role: "curator",
        action: "revoke",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "ed_locked" });
    expect(mockTxUnitAdminDelete).not.toHaveBeenCalled();
    expect(mockTxUnitAdminUpsert).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("Non-superuser re-grant (role change) of an ED row → 403 ed_locked (no write)", async () => {
    mockUnitAdminFindUnique.mockResolvedValue({
      role: "curator",
      grantedBy: "ED-ETL",
      source: "ED:IAMDELA",
    });
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: "ed0001",
        role: "owner",
        action: "grant",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "ed_locked" });
    expect(mockTxUnitAdminUpsert).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("Superuser override of an ED row is allowed (write proceeds)", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockUnitAdminFindUnique.mockResolvedValue({
      role: "curator",
      grantedBy: "ED-ETL",
      source: "ED:DA",
    });
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: "ed0001",
        role: "owner",
        action: "grant",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxUnitAdminUpsert).toHaveBeenCalledOnce();
  });

  it("Non-ED (manual) row is unaffected by the gate (regression)", async () => {
    mockUnitAdminFindUnique.mockResolvedValue({
      role: "curator",
      grantedBy: "own001",
      source: "manual",
    });
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: "man001",
        role: "owner",
        action: "grant",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxUnitAdminUpsert).toHaveBeenCalledOnce();
  });

  it("Unit not found → 400 unit_not_found", async () => {
    mockDepartmentFindUnique.mockResolvedValue(null);
    const res = await POST(
      post({
        entityType: "department",
        entityId: "GHOST",
        cwid: "new001",
        role: "curator",
        action: "grant",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "unit_not_found" });
  });

  it("Invalid role → 400 invalid_role", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        cwid: "new001",
        role: "admin",
        action: "grant",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_role" });
  });
});
