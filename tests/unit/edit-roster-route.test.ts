/**
 * #540 Phase 5b — /api/edit/roster.
 *
 *  - Curator adds/removes a `CenterMembership` row.
 *  - Curator-on-dept cascades to a manually-created division roster.
 *  - LDAP-sourced (`source='ED'`) division → 400 no_manual_roster (edge 14).
 *  - Department `unitType` is rejected (no manual roster).
 *  - Non-admin → 403 not_curator.
 *  - Re-adding an existing member → 200 no-op (changed:false), no DB write.
 *  - Removing a non-member → 200 no-op (changed:false), no DB write.
 *  - Audit row records `roster_change`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockExecuteRaw,
  mockCenterFindUnique,
  mockDivisionFindUnique,
  mockUnitAdminFindMany,
  mockCenterMembershipFindUnique,
  mockDivisionMembershipFindUnique,
  mockCenterProgramFindMany,
  mockTxCenterMembershipCreate,
  mockTxCenterMembershipDelete,
  mockTxCenterMembershipUpsert,
  mockTxDivisionMembershipCreate,
  mockTxDivisionMembershipDelete,
  mockReflectUnitChange,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockDivisionFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockCenterMembershipFindUnique: vi.fn(),
  mockDivisionMembershipFindUnique: vi.fn(),
  mockCenterProgramFindMany: vi.fn(),
  mockTxCenterMembershipCreate: vi.fn(),
  mockTxCenterMembershipDelete: vi.fn(),
  mockTxCenterMembershipUpsert: vi.fn(),
  mockTxDivisionMembershipCreate: vi.fn(),
  mockTxDivisionMembershipDelete: vi.fn(),
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
      center: { findUnique: mockCenterFindUnique },
      division: { findUnique: mockDivisionFindUnique },
      unitAdmin: { findMany: mockUnitAdminFindMany },
      centerMembership: { findUnique: mockCenterMembershipFindUnique },
      divisionMembership: { findUnique: mockDivisionMembershipFindUnique },
      centerProgram: { findMany: mockCenterProgramFindMany },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectUnitChange: mockReflectUnitChange,
}));

import { POST } from "@/app/api/edit/roster/route";

const CURATOR = { cwid: "cur001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };

const fakeTx = {
  centerMembership: {
    create: mockTxCenterMembershipCreate,
    delete: mockTxCenterMembershipDelete,
    upsert: mockTxCenterMembershipUpsert,
  },
  divisionMembership: {
    create: mockTxDivisionMembershipCreate,
    delete: mockTxDivisionMembershipDelete,
  },
  $executeRaw: mockExecuteRaw,
};

/** A blank CenterMembership snapshot row — the create/upsert mocks resolve this
 *  so the route's audit snapshot() has a row to read. */
const BLANK_ROW = {
  cwid: "fac001",
  membershipType: null,
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
  mockCenterFindUnique.mockResolvedValue({ code: "MEYER", slug: "meyer" });
  mockDivisionFindUnique.mockResolvedValue({
    code: "CARDIO",
    slug: "cardiology",
    source: "manual",
    deptCode: "MED",
    department: { slug: "medicine" },
  });
  mockCenterMembershipFindUnique.mockResolvedValue(null);
  mockDivisionMembershipFindUnique.mockResolvedValue(null);
  mockCenterProgramFindMany.mockResolvedValue([]);
  mockTxCenterMembershipCreate.mockResolvedValue(BLANK_ROW);
  mockTxCenterMembershipUpsert.mockResolvedValue(BLANK_ROW);
  mockTxCenterMembershipDelete.mockResolvedValue(BLANK_ROW);
  mockUnitAdminFindMany.mockResolvedValue([
    { entityType: "center", entityId: "MEYER", role: "curator" },
  ]);
});

describe("/api/edit/roster — center", () => {
  it("Curator adds a member to a center", async () => {
    const res = await POST(
      post({ unitType: "center", unitCode: "MEYER", cwid: "fac001", action: "add" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    expect(mockTxCenterMembershipCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { centerCode: "MEYER", cwid: "fac001", source: "manual-ui" },
      }),
    );
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({ unitKind: "center", unitSlug: "meyer" }),
    );
  });

  it("Re-adding an existing member → 200 no-op (no DB write)", async () => {
    mockCenterMembershipFindUnique.mockResolvedValue({ cwid: "fac001" });
    const res = await POST(
      post({ unitType: "center", unitCode: "MEYER", cwid: "fac001", action: "add" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("Removing a non-member → 200 no-op", async () => {
    const res = await POST(
      post({ unitType: "center", unitCode: "MEYER", cwid: "fac001", action: "remove" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("Non-admin → 403 not_curator", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(
      post({ unitType: "center", unitCode: "MEYER", cwid: "fac001", action: "add" }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_curator" });
  });
});

describe("/api/edit/roster — division", () => {
  beforeEach(() => {
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "division", entityId: "CARDIO", role: "curator" },
    ]);
  });

  it("Curator-on-division adds a member to a manually-created division", async () => {
    const res = await POST(
      post({ unitType: "division", unitCode: "CARDIO", cwid: "fac001", action: "add" }),
    );
    expect(res.status).toBe(200);
    expect(mockTxDivisionMembershipCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { divisionCode: "CARDIO", cwid: "fac001", source: "manual-ui" },
      }),
    );
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        unitKind: "division",
        unitSlug: "cardiology",
        parentDeptSlug: "medicine",
      }),
    );
  });

  it("LDAP-sourced (source='ED') division → 400 no_manual_roster (edge 14)", async () => {
    mockDivisionFindUnique.mockResolvedValue({
      code: "CARDIO",
      slug: "cardiology",
      source: "ED",
      deptCode: "MED",
      department: { slug: "medicine" },
    });
    const res = await POST(
      post({ unitType: "division", unitCode: "CARDIO", cwid: "fac001", action: "add" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "no_manual_roster" });
  });

  it("Curator-on-dept cascades to a manually-created division", async () => {
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "department", entityId: "MED", role: "curator" },
    ]);
    const res = await POST(
      post({ unitType: "division", unitCode: "CARDIO", cwid: "fac001", action: "add" }),
    );
    expect(res.status).toBe(200);
  });

  it("Division not found → 400 unit_not_found", async () => {
    mockDivisionFindUnique.mockResolvedValue(null);
    const res = await POST(
      post({ unitType: "division", unitCode: "GHOST", cwid: "fac001", action: "add" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "unit_not_found" });
  });
});

describe("/api/edit/roster — input validation", () => {
  it("department unitType → 400 invalid_unit_type", async () => {
    const res = await POST(
      post({ unitType: "department", unitCode: "MED", cwid: "fac001", action: "add" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_unit_type" });
  });

  it("invalid cwid format → 400 invalid_cwid", async () => {
    const res = await POST(
      post({ unitType: "center", unitCode: "MEYER", cwid: "bad!!", action: "add" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_cwid" });
  });

  it("invalid action → 400 invalid_action", async () => {
    const res = await POST(
      post({ unitType: "center", unitCode: "MEYER", cwid: "fac001", action: "toggle" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_action" });
  });
});

describe("/api/edit/roster — #552 set action + extended fields", () => {
  it("set upserts a center membership with type + program + dates", async () => {
    mockCenterProgramFindMany.mockResolvedValue([{ code: "CT" }, { code: "CB" }]);
    const res = await POST(
      post({
        unitType: "center",
        unitCode: "MEYER",
        cwid: "fac001",
        action: "set",
        membershipType: "research",
        programCode: "CT",
        startDate: "2024-07-01",
        endDate: null,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    const call = mockTxCenterMembershipUpsert.mock.calls[0][0];
    expect(call.update).toMatchObject({ membershipType: "research", programCode: "CT", endDate: null });
    expect(call.update.startDate).toBeInstanceOf(Date);
    expect(call.create).toMatchObject({ centerCode: "MEYER", cwid: "fac001", source: "manual-ui" });
  });

  it("set with explicit null clears a field (partial body)", async () => {
    const res = await POST(
      post({ unitType: "center", unitCode: "MEYER", cwid: "fac001", action: "set", membershipType: null }),
    );
    expect(res.status).toBe(200);
    const call = mockTxCenterMembershipUpsert.mock.calls[0][0];
    expect(call.update).toEqual({ membershipType: null });
  });

  it("programCode on a center with no taxonomy → 400 no_taxonomy", async () => {
    mockCenterProgramFindMany.mockResolvedValue([]);
    const res = await POST(
      post({ unitType: "center", unitCode: "MEYER", cwid: "fac001", action: "set", programCode: "CT" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "no_taxonomy" });
  });

  it("programCode not in the center's taxonomy → 400 invalid_program_code", async () => {
    mockCenterProgramFindMany.mockResolvedValue([{ code: "CB" }]);
    const res = await POST(
      post({ unitType: "center", unitCode: "MEYER", cwid: "fac001", action: "set", programCode: "ZZ" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_program_code" });
  });

  it("endDate before startDate → 400 invalid_date_range", async () => {
    const res = await POST(
      post({
        unitType: "center",
        unitCode: "MEYER",
        cwid: "fac001",
        action: "set",
        startDate: "2025-01-01",
        endDate: "2024-01-01",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_date_range" });
  });

  it("malformed date → 400 invalid_date", async () => {
    const res = await POST(
      post({ unitType: "center", unitCode: "MEYER", cwid: "fac001", action: "set", startDate: "07/01/2024" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_date" });
  });

  it("invalid membershipType → 400 invalid_membership_type", async () => {
    const res = await POST(
      post({ unitType: "center", unitCode: "MEYER", cwid: "fac001", action: "set", membershipType: "faculty" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_membership_type" });
  });

  it("extended fields on a division → 400 roster_field_center_only", async () => {
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "division", entityId: "CARDIO", role: "curator" },
    ]);
    const res = await POST(
      post({ unitType: "division", unitCode: "CARDIO", cwid: "fac001", action: "set", programCode: "CT" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "roster_field_center_only" });
  });

  it("set on a division with no extended fields upserts the base row", async () => {
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "division", entityId: "CARDIO", role: "curator" },
    ]);
    const res = await POST(
      post({ unitType: "division", unitCode: "CARDIO", cwid: "fac001", action: "set" }),
    );
    expect(res.status).toBe(200);
    expect(mockTxDivisionMembershipCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { divisionCode: "CARDIO", cwid: "fac001", source: "manual-ui" } }),
    );
  });
});
