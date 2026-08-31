/**
 * #2557 Phase E (T2) — the `OrgUnitRoleScope` allowlist gate wired into
 * `/api/edit/roster`'s `handleCenter` (and, defense-in-depth, the Cornell
 * (Ithaca) add's center branch).
 *
 * Exercises the REAL route handler (not `isRoleAllowedAtUnit` in isolation —
 * that contract is pinned separately in `org-unit-role-scope.test.ts`), with
 * `tx.orgUnitRoleScope.findMany` stubbed to stand in for the scope table:
 *
 *  - `research` at the unit it's allowlisted for → SUCCEEDS.
 *  - `research` at a unit NOT on its allowlist → REJECTED, 400, no write.
 *  - `member` (no scope rows for it) → succeeds at any unit, allowlisted or
 *    not — the "zero rows == unrestricted" default every other role gets.
 *  - An EXISTING row already holding a scope-restricted role at a unit off
 *    its allowlist (the hypothetical pre-existing anomaly) keeps working on
 *    an action that does not touch `membershipType` — guard rail 1, existing
 *    holders keep rendering; the gate only ever blocks a NEW role write.
 *  - The Cornell (Ithaca) add's center branch (hardcoded `member`) still
 *    succeeds now that it also calls the gate.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockExecuteRaw,
  mockCenterFindUnique,
  mockUnitAdminFindMany,
  mockCenterMembershipFindUnique,
  mockScholarFindFirst,
  mockTxCenterMembershipCreate,
  mockTxCenterMembershipUpsert,
  mockTxOrgUnitRoleScopeFindMany,
  mockTxExternalMemberUpsert,
  mockReflectUnitChange,
  mockFetchCornellPersonByNetid,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockCenterMembershipFindUnique: vi.fn(),
  mockScholarFindFirst: vi.fn(),
  mockTxCenterMembershipCreate: vi.fn(),
  mockTxCenterMembershipUpsert: vi.fn(),
  mockTxOrgUnitRoleScopeFindMany: vi.fn(),
  mockTxExternalMemberUpsert: vi.fn(),
  mockReflectUnitChange: vi.fn(),
  mockFetchCornellPersonByNetid: vi.fn(),
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
      center: { findUnique: mockCenterFindUnique },
      unitAdmin: { findMany: mockUnitAdminFindMany },
      centerMembership: { findUnique: mockCenterMembershipFindUnique },
      scholar: { findFirst: mockScholarFindFirst },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectUnitChange: mockReflectUnitChange,
}));
vi.mock("@/lib/edit/cornell-directory-flag", () => ({
  isCornellDirectoryMembersEnabled: () => true,
}));
vi.mock("@/lib/sources/cornell-ldap", () => ({
  fetchCornellPersonByNetid: mockFetchCornellPersonByNetid,
}));

import { POST } from "@/app/api/edit/roster/route";

const CURATOR = { cwid: "cur001", isSuperuser: false };

const mockTxCenterRoleCreateMany = vi.fn();

const fakeTx = {
  centerMembership: {
    create: mockTxCenterMembershipCreate,
    upsert: mockTxCenterMembershipUpsert,
  },
  orgUnitRole: { createMany: mockTxCenterRoleCreateMany },
  orgUnitRoleScope: { findMany: mockTxOrgUnitRoleScopeFindMany },
  externalMember: { upsert: mockTxExternalMemberUpsert },
  $executeRaw: mockExecuteRaw,
};

const BLANK_ROW = {
  cwid: "fac001",
  membershipType: null,
  membershipRoleKey: "member",
  programCode: null,
  startDate: null,
  endDate: null,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/roster", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(CURATOR);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockExecuteRaw.mockResolvedValue(1);
  mockUnitAdminFindMany.mockResolvedValue([
    { entityType: "center", entityId: "meyer_cancer_center", role: "curator" },
    { entityType: "center", entityId: "other_center", role: "curator" },
  ]);
  mockCenterMembershipFindUnique.mockResolvedValue(null);
  mockTxCenterMembershipUpsert.mockResolvedValue(BLANK_ROW);
  mockTxCenterMembershipCreate.mockResolvedValue(BLANK_ROW);
  // Default: the scope table is empty for whatever (entityType, roleKey) the
  // gate asks about — unrestricted, exactly today's live-prod shape for every
  // role except `research`/`clinical`. Individual tests override this to seed
  // Meyer's allowlist rows.
  mockTxOrgUnitRoleScopeFindMany.mockResolvedValue([]);
});

describe("/api/edit/roster — handleCenter allowlist gate (#2557 T2)", () => {
  it("research at its allowlisted unit succeeds", async () => {
    mockCenterFindUnique.mockResolvedValue({ code: "meyer_cancer_center", slug: "meyer" });
    mockTxOrgUnitRoleScopeFindMany.mockImplementation(
      async ({ where }: { where: { entityType: string; roleKey: string } }) =>
        where.roleKey === "research"
          ? [{ entityId: "meyer_cancer_center" }]
          : [],
    );

    const res = await POST(
      post({
        unitType: "center",
        unitCode: "meyer_cancer_center",
        cwid: "fac001",
        action: "set",
        membershipType: "research",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(mockTxOrgUnitRoleScopeFindMany).toHaveBeenCalledWith({
      where: { entityType: "center", roleKey: "research" },
      select: { entityId: true },
    });
    expect(mockTxCenterMembershipUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ membershipRoleKey: "research" }),
      }),
    );
    expect(mockReflectUnitChange).toHaveBeenCalled();
  });

  it("research at a unit NOT on its allowlist is REJECTED — 400, no write", async () => {
    mockCenterFindUnique.mockResolvedValue({ code: "other_center", slug: "other" });
    mockTxOrgUnitRoleScopeFindMany.mockImplementation(
      async ({ where }: { where: { entityType: string; roleKey: string } }) =>
        where.roleKey === "research"
          ? [{ entityId: "meyer_cancer_center" }]
          : [],
    );

    const res = await POST(
      post({
        unitType: "center",
        unitCode: "other_center",
        cwid: "fac001",
        action: "set",
        membershipType: "research",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "role_not_allowed_at_unit",
      field: "membershipType",
    });
    // Nothing committed — the throw happens before any write in the tx.
    expect(mockTxCenterMembershipUpsert).not.toHaveBeenCalled();
    expect(mockTxCenterRoleCreateMany).not.toHaveBeenCalled();
    expect(mockReflectUnitChange).not.toHaveBeenCalled();
  });

  it("clinical at a non-Meyer unit via `add` (create branch) is also REJECTED", async () => {
    mockCenterFindUnique.mockResolvedValue({ code: "other_center", slug: "other" });
    mockTxOrgUnitRoleScopeFindMany.mockImplementation(
      async ({ where }: { where: { entityType: string; roleKey: string } }) =>
        where.roleKey === "clinical"
          ? [{ entityId: "meyer_cancer_center" }]
          : [],
    );

    const res = await POST(
      post({
        unitType: "center",
        unitCode: "other_center",
        cwid: "fac001",
        action: "add",
        membershipType: "clinical",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "role_not_allowed_at_unit" });
    expect(mockTxCenterMembershipCreate).not.toHaveBeenCalled();
  });

  it("member (unrestricted — zero scope rows) succeeds at ANY unit, including a restricted center", async () => {
    mockCenterFindUnique.mockResolvedValue({ code: "other_center", slug: "other" });
    // Scope rows exist for research/clinical (Meyer-only) but NONE for
    // `member` — the gate must resolve `member` as unrestricted regardless.
    mockTxOrgUnitRoleScopeFindMany.mockImplementation(
      async ({ where }: { where: { entityType: string; roleKey: string } }) =>
        where.roleKey === "research" || where.roleKey === "clinical"
          ? [{ entityId: "meyer_cancer_center" }]
          : [],
    );

    const res = await POST(
      post({
        unitType: "center",
        unitCode: "other_center",
        cwid: "fac001",
        action: "set",
        membershipType: null,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(mockTxCenterMembershipUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ membershipRoleKey: "member" }),
      }),
    );
  });

  it("an EXISTING off-allowlist NCI row keeps working on a write that doesn't touch membershipType", async () => {
    // The hypothetical pre-existing anomaly guard rail 1 protects: a row
    // already holding `research` at a unit that is NOT on today's allowlist.
    // A `set` that only touches `programCode` must still succeed — the gate
    // only fires when the body itself carries `membershipType`.
    mockCenterFindUnique.mockResolvedValue({ code: "other_center", slug: "other" });
    mockCenterMembershipFindUnique.mockResolvedValue({
      cwid: "fac001",
      membershipType: "research",
      membershipRoleKey: "research",
      programCode: null,
      startDate: null,
      endDate: null,
    });
    mockTxOrgUnitRoleScopeFindMany.mockImplementation(
      async ({ where }: { where: { entityType: string; roleKey: string } }) =>
        where.roleKey === "research"
          ? [{ entityId: "meyer_cancer_center" }]
          : [],
    );

    const res = await POST(
      post({
        unitType: "center",
        unitCode: "other_center",
        cwid: "fac001",
        action: "set",
        // No `membershipType` key at all in the body — the existing
        // `research` role key on the row is left untouched (upsert `update`
        // only carries fields present in the body, same as any other #552
        // partial `set`).
        programCode: null,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    // The gate must never have run — no `membershipType` in the body.
    expect(mockTxOrgUnitRoleScopeFindMany).not.toHaveBeenCalled();
    expect(mockTxCenterMembershipUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { programCode: null },
      }),
    );
  });

  it("a defaulted `member` CREATE (no `membershipType` in the body at all) is gated too", async () => {
    // Closes the T2 gap: `handleCenter` only gated when the body carried an
    // explicit `membershipType`, so a `set`/`add` that defaults a brand-new
    // row to `MEMBER_ROLE_KEY` bypassed the check entirely. No existing row
    // (default `mockCenterMembershipFindUnique` → null), so this `set`
    // upserts through the CREATE branch and stamps `member`.
    mockCenterFindUnique.mockResolvedValue({ code: "other_center", slug: "other" });
    mockTxOrgUnitRoleScopeFindMany.mockImplementation(
      async ({ where }: { where: { entityType: string; roleKey: string } }) =>
        where.roleKey === "member" ? [{ entityId: "meyer_cancer_center" }] : [],
    );

    const res = await POST(
      post({
        unitType: "center",
        unitCode: "other_center",
        cwid: "fac001",
        action: "set",
        // No `membershipType` key at all — the pre-fix code never checked
        // this write, since `ext.membershipType.present` was false.
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "role_not_allowed_at_unit" });
    expect(mockTxOrgUnitRoleScopeFindMany).toHaveBeenCalledWith({
      where: { entityType: "center", roleKey: "member" },
      select: { entityId: true },
    });
    // Nothing committed — same before-any-write guarantee as the explicit
    // `membershipType` rejections above.
    expect(mockTxCenterMembershipUpsert).not.toHaveBeenCalled();
    expect(mockTxCenterRoleCreateMany).not.toHaveBeenCalled();
    expect(mockReflectUnitChange).not.toHaveBeenCalled();
  });

  it("the ordinary unscoped `member` CREATE (no `membershipType`, zero scope rows) still succeeds at any center", async () => {
    // The permissive-empty invariant, on the exact path the previous test
    // just gated: `member` has no scope rows in prod today, so this must
    // keep working unchanged.
    mockCenterFindUnique.mockResolvedValue({ code: "other_center", slug: "other" });
    // Default `mockTxOrgUnitRoleScopeFindMany` (set in `beforeEach`) already
    // resolves `[]` for every role — unrestricted.

    const res = await POST(
      post({
        unitType: "center",
        unitCode: "other_center",
        cwid: "fac001",
        action: "set",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(mockTxOrgUnitRoleScopeFindMany).toHaveBeenCalledWith({
      where: { entityType: "center", roleKey: "member" },
      select: { entityId: true },
    });
    expect(mockTxCenterMembershipUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ membershipRoleKey: "member" }),
      }),
    );
  });
});

describe("/api/edit/roster — Cornell (Ithaca) add, center branch (#2557 T2 defense-in-depth)", () => {
  it("still succeeds — hardcoded `member` role always passes the gate", async () => {
    mockCenterFindUnique.mockResolvedValue({ code: "other_center", slug: "other" });
    // `resolveCornellRosterAdd` calls this TWICE: first the defensive
    // netid-collision check (must be null — the netid is not itself a WCM
    // cwid), then the real bridge lookup for `cornellEduCWID` ("fac001",
    // which IS an active Scholar).
    mockScholarFindFirst.mockImplementation(
      async ({ where }: { where: { cwid: string } }) =>
        where.cwid === "fac001" ? { cwid: "fac001" } : null,
    );
    mockFetchCornellPersonByNetid.mockResolvedValue({
      netid: "abc1234",
      name: "Test Person",
      givenName: "Test",
      familyName: "Person",
      title: null,
      dept: null,
      email: null,
      affiliation: null,
      cornellEduCWID: "fac001",
    });

    const res = await POST(
      post({
        unitType: "center",
        unitCode: "other_center",
        source: "cornell",
        netid: "abc1234",
        action: "add",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true, cwid: "fac001" });
    expect(mockTxOrgUnitRoleScopeFindMany).toHaveBeenCalledWith({
      where: { entityType: "center", roleKey: "member" },
      select: { entityId: true },
    });
    expect(mockTxCenterMembershipCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ membershipRoleKey: "member" }),
      }),
    );
  });
});
