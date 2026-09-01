/**
 * #540 Phase 5b — /api/edit/unit.
 *
 * Covers two operations:
 *
 *  - `op:"create"`:
 *      - Owner of parent dept creates an informal center (synthetic code).
 *      - Non-Owner non-Superuser → 403 not_unit_owner.
 *      - Superuser creates a coded division (real LDAP N-code).
 *      - Non-Superuser tries coded division → 403 not_superuser.
 *      - centerType="institute" by a non-Superuser → 403 not_superuser.
 *      - Parent dept not found → 400 dept_not_found.
 *      - Slug collision → 400 slug_taken.
 *      - Superuser omits deptCode on a center → 200, audits dept_code: null
 *        (#2541); everyone else, and every division, still 400s without one.
 *      - A NON-Superuser creator is seeded as Owner of the new center + a
 *        `grant_change` audit row (#2544); a Superuser creator gets neither.
 *
 *  - `op:"update"` (center in-row):
 *      - Curator edits description; success + reflectUnitChange.
 *      - slug + centerType are Superuser-only.
 *      - Slug update revalidates the old slug too (previousSlug).
 *      - directorCwid="" vacates the `director` assignment in
 *        `OrgUnitRoleAssignment` (#2542 contract A; the deprecated column
 *        write retired with this ticket).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockExecuteRaw,
  mockDepartmentFindUnique,
  mockDivisionFindUnique,
  mockTxDivisionUpdate,
  mockTxDivisionFindUnique,
  mockCenterFindUnique,
  mockDivisionFindFirst,
  mockUnitAdminFindMany,
  mockTxCenterCreate,
  mockTxDivisionCreate,
  mockTxCenterFindUnique,
  mockTxCenterUpdate,
  mockTxUnitAdminCreate,
  mockReflectUnitChange,
  mockIsOrgUnitCreateSuperuserOnly,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockDepartmentFindUnique: vi.fn(),
  mockDivisionFindUnique: vi.fn(),
  mockTxDivisionUpdate: vi.fn(),
  mockTxDivisionFindUnique: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockDivisionFindFirst: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockTxCenterCreate: vi.fn(),
  mockTxDivisionCreate: vi.fn(),
  mockTxCenterFindUnique: vi.fn(),
  mockTxCenterUpdate: vi.fn(),
  mockTxUnitAdminCreate: vi.fn(),
  mockReflectUnitChange: vi.fn(),
  mockIsOrgUnitCreateSuperuserOnly: vi.fn(),
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
      department: { findUnique: mockDepartmentFindUnique, findFirst: vi.fn() },
      division: { findUnique: mockDivisionFindUnique, findFirst: mockDivisionFindFirst },
      center: { findUnique: mockCenterFindUnique },
      unitAdmin: { findMany: mockUnitAdminFindMany },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectUnitChange: mockReflectUnitChange,
}));
vi.mock("@/lib/edit/unit-create-flags", () => ({
  isOrgUnitCreateSuperuserOnly: mockIsOrgUnitCreateSuperuserOnly,
}));

import { POST } from "@/app/api/edit/unit/route";

const OWNER = { cwid: "own001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };
const SUPERUSER = { cwid: "sup001", isSuperuser: true };

const mockTxCenterLeaderFindFirst = vi.fn();
const mockTxCenterLeaderCreate = vi.fn();
const mockTxCenterLeaderUpdateMany = vi.fn();
const mockTxCenterLeaderDeleteMany = vi.fn();
const mockTxCenterRoleCreateMany = vi.fn();

const fakeTx = {
  center: {
    create: mockTxCenterCreate,
    findUnique: mockTxCenterFindUnique,
    update: mockTxCenterUpdate,
  },
  division: {
    create: mockTxDivisionCreate,
    findUnique: mockTxDivisionFindUnique,
    update: mockTxDivisionUpdate,
  },
  unitAdmin: { create: mockTxUnitAdminCreate },
  // #2542 — center leadership writes land on `CenterLeader`, preceded by a lazy
  // `centerRole` seed, so the transaction stub needs both delegates or every
  // center update throws.
  orgUnitRoleAssignment: {
    findFirst: mockTxCenterLeaderFindFirst,
    create: mockTxCenterLeaderCreate,
    updateMany: mockTxCenterLeaderUpdateMany,
    deleteMany: mockTxCenterLeaderDeleteMany,
  },
  orgUnitRole: { createMany: mockTxCenterRoleCreateMany },
  $executeRaw: mockExecuteRaw,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/unit", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Default OFF (#728 Phase D): the Owner-create path is preserved, so every
  // existing create test exercises unchanged behavior. The lockdown tests below
  // opt in explicitly.
  mockIsOrgUnitCreateSuperuserOnly.mockReturnValue(false);
  mockGetEditSession.mockResolvedValue(OWNER);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockExecuteRaw.mockResolvedValue(1);
  mockDepartmentFindUnique.mockResolvedValue({ code: "MED", slug: "medicine" });
  mockDivisionFindUnique.mockResolvedValue(null);
  mockDivisionFindFirst.mockResolvedValue(null);
  mockCenterFindUnique.mockResolvedValue(null);
  mockUnitAdminFindMany.mockResolvedValue([
    { entityType: "department", entityId: "MED", role: "owner" },
  ]);
  mockTxCenterCreate.mockImplementation(async (args: { data: { code: string } }) => ({
    code: args.data.code,
  }));
  mockTxDivisionCreate.mockImplementation(async (args: { data: { code: string } }) => ({
    code: args.data.code,
  }));
  mockTxCenterFindUnique.mockResolvedValue({
    slug: "old-slug",
    description: "old",
    url: null,
    directorCwid: null,
    leaderInterim: false,
    centerType: "center",
  });
  mockTxCenterUpdate.mockResolvedValue({});
  mockTxUnitAdminCreate.mockResolvedValue({});
});

describe("/api/edit/unit op:'create' — informal center", () => {
  it("Owner creates an informal center under their parent dept", async () => {
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "Imaging Working Group",
        slug: "imaging-working-group",
        deptCode: "MED",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.code).toMatch(/^man-[0-9a-f]{8}$/);
    expect(json.slug).toBe("imaging-working-group");
    expect(mockTxCenterCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "manual",
          centerType: "center",
        }),
      }),
    );
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({ unitKind: "center", unitSlug: "imaging-working-group" }),
    );
  });

  it("Non-admin → 403 not_unit_owner (Curator-only cannot create either)", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "department", entityId: "MED", role: "curator" },
    ]);
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "X",
        slug: "x",
        deptCode: "MED",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_unit_owner" });
  });

  // 2026-08-26 policy widening (decision #3) is scoped to `canManageAccess` /
  // `canGrant` (granting/revoking `unit_admin` rows) — org-unit CREATE stays
  // excluded from comms_steward parity (`comms-steward-profile-editing-
  // spec.md` §3b: "adding/remove org units"). This route deliberately does
  // NOT call the widened `canManageAccess` for this reason.
  it("comms_steward with no unit_admin row → 403 not_unit_owner (create stays excluded)", async () => {
    mockGetEditSession.mockResolvedValue({
      cwid: "stw001",
      isSuperuser: false,
      isCommsSteward: true,
    });
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "X",
        slug: "x",
        deptCode: "MED",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_unit_owner" });
  });

  it("Superuser creates an informal center without an Owner row", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "Y",
        slug: "y",
        deptCode: "MED",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("centerType='institute' is rejected for a non-Superuser", async () => {
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "Z",
        slug: "z",
        deptCode: "MED",
        centerType: "institute",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_superuser" });
  });

  it("Parent dept not found → 400 dept_not_found", async () => {
    mockDepartmentFindUnique.mockResolvedValue(null);
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "X",
        slug: "x",
        deptCode: "GHOST",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "dept_not_found" });
  });

  it("Slug collision → 400 slug_taken", async () => {
    mockCenterFindUnique.mockImplementation(
      async (args: { where: { slug?: string; code?: string } }) =>
        args.where.slug === "taken" ? { code: "OTHER" } : null,
    );
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "X",
        slug: "taken",
        deptCode: "MED",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "slug_taken" });
  });
});

describe("/api/edit/unit op:'create' — the creator's owner grant (#2544)", () => {
  /** The audit INSERT's bound values, positionally (arg 0 is the template
   *  strings): 1 actor_cwid, 2 target_entity_type, 3 target_entity_id,
   *  4 action, 5 fields_changed, 6 before_values, 7 after_values. */
  function auditCall(n: number): unknown[] {
    return mockExecuteRaw.mock.calls[n] as unknown[];
  }

  it("a NON-Superuser Owner is seeded as Owner of the center they just created", async () => {
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "Imaging Working Group",
        slug: "imaging-working-group",
        deptCode: "MED",
      }),
    );
    expect(res.status).toBe(200);
    const createdCode = (await res.json()).code as string;

    // Centers never cascade, so this row is the ONLY thing that leaves the
    // creator able to edit / grant on their own center.
    expect(mockTxUnitAdminCreate).toHaveBeenCalledTimes(1);
    expect(mockTxUnitAdminCreate).toHaveBeenCalledWith({
      data: {
        entityType: "center",
        entityId: createdCode,
        cwid: OWNER.cwid,
        role: "owner",
        grantedBy: OWNER.cwid,
      },
    });
  });

  it("the minted grant appends a SECOND audit row — `grant_change`, after `unit_create`", async () => {
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "Imaging Working Group",
        slug: "imaging-working-group",
        deptCode: "MED",
      }),
    );
    expect(res.status).toBe(200);
    const createdCode = (await res.json()).code as string;

    // ONE transaction, not two: a refactor that moved the grant into its own
    // `$transaction` would produce identical row counts but could leave an
    // ownerless center behind on a partial failure — the original bug.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
    expect(auditCall(0)[4]).toBe("unit_create");

    const grantRow = auditCall(1);
    // `grant_change` already exists in BOTH the TS union and the audit-log
    // ENUM — a new action would pass tsc here and then MySQL-1265 the whole
    // transaction at runtime.
    expect(grantRow[4]).toBe("grant_change");
    expect(grantRow[1]).toBe(OWNER.cwid); // actor_cwid
    expect(grantRow[2]).toBe("center"); // target_entity_type
    expect(grantRow[3]).toBe(createdCode); // target_entity_id
    expect(grantRow[6]).toBeNull(); // before_values — nothing existed
    expect(JSON.parse(grantRow[7] as string)).toEqual({
      cwid: OWNER.cwid,
      role: "owner",
      granted_by: OWNER.cwid,
    });
  });

  it("a SUPERUSER creating a center mints NO unit_admin row (they already pass every check)", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "Y",
        slug: "y",
        deptCode: "MED",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxCenterCreate).toHaveBeenCalledTimes(1);
    expect(mockTxUnitAdminCreate).not.toHaveBeenCalled();
    // ...and therefore exactly one audit row.
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(auditCall(0)[4]).toBe("unit_create");
  });

  it("a coded division mints no grant either — divisions cascade from the parent dept", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const res = await POST(
      post({
        op: "create",
        unitType: "division",
        name: "Newly Coded Division",
        slug: "newly-coded",
        deptCode: "MED",
        code: "N9999",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxUnitAdminCreate).not.toHaveBeenCalled();
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });
});

describe("/api/edit/unit op:'create' — center with no parent department (#2541)", () => {
  /** `after_values` is the 7th bound value of the audit INSERT (see
   *  `appendAuditRow`'s positional order); arg 0 is the template strings. */
  function auditAfterValues(): Record<string, unknown> {
    return JSON.parse(mockExecuteRaw.mock.calls[0][7] as string);
  }

  it("Superuser omits deptCode entirely → 200, no dept lookup, dept_code audited null", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "Cross-Campus Initiative",
        slug: "cross-campus-initiative",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockDepartmentFindUnique).not.toHaveBeenCalled();
    expect(mockTxCenterCreate).toHaveBeenCalledTimes(1);
    expect(auditAfterValues()).toMatchObject({ unit_type: "center", dept_code: null });
  });

  it("Superuser sends deptCode: null (the form's wire value) → 200", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "Cross-Campus Initiative",
        slug: "cross-campus-initiative",
        deptCode: null,
      }),
    );
    expect(res.status).toBe(200);
    expect(auditAfterValues()).toMatchObject({ dept_code: null });
  });

  it("Owner (non-Superuser) still needs a deptCode — it is what admits them", async () => {
    const res = await POST(
      post({ op: "create", unitType: "center", name: "X", slug: "x" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_dept_code" });
    expect(mockTxCenterCreate).not.toHaveBeenCalled();
  });

  it("a division still needs a deptCode even for a Superuser — it is a real FK", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const res = await POST(
      post({ op: "create", unitType: "division", name: "X", slug: "x", code: "N9999" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_dept_code" });
    expect(mockTxDivisionCreate).not.toHaveBeenCalled();
  });

  it("a SUPPLIED deptCode is still validated — unknown → 400 dept_not_found", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockDepartmentFindUnique.mockResolvedValue(null);
    const res = await POST(
      post({ op: "create", unitType: "center", name: "X", slug: "x", deptCode: "GHOST" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "dept_not_found" });
  });

  it("deptCode:'' is NOT an omission — 400 invalid_dept_code even for a Superuser", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const res = await POST(
      post({ op: "create", unitType: "center", name: "X", slug: "x", deptCode: "" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_dept_code" });
  });

  it("lockdown flag ON: a Superuser may still omit it; a non-Superuser 400s before the 403", async () => {
    // Deliberate ordering: the file's "a 400 precedes any authz check"
    // invariant means the missing-deptCode 400 wins over `not_superuser`.
    mockIsOrgUnitCreateSuperuserOnly.mockReturnValue(true);
    const denied = await POST(
      post({ op: "create", unitType: "center", name: "X", slug: "x" }),
    );
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ ok: false, error: "invalid_dept_code" });

    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const allowed = await POST(
      post({ op: "create", unitType: "center", name: "Y", slug: "y" }),
    );
    expect(allowed.status).toBe(200);
  });
});

describe("/api/edit/unit op:'create' — org-unit lockdown (#728 Phase D § 4.5)", () => {
  it("flag ON: an Owner of the parent dept is refused → 403 not_superuser (no write)", async () => {
    mockIsOrgUnitCreateSuperuserOnly.mockReturnValue(true);
    // OWNER (the beforeEach default) owns MED — allowed when the flag is OFF.
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "Imaging Working Group",
        slug: "imaging-working-group",
        deptCode: "MED",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_superuser" });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockTxCenterCreate).not.toHaveBeenCalled();
  });

  it("flag ON: a Superuser still creates the informal center → 200", async () => {
    mockIsOrgUnitCreateSuperuserOnly.mockReturnValue(true);
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "Y",
        slug: "y",
        deptCode: "MED",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxCenterCreate).toHaveBeenCalledTimes(1);
  });

  it("flag OFF (default): the Owner-create path is unchanged → 200", async () => {
    // Explicit regression: the existing default-off behavior must not move.
    const res = await POST(
      post({
        op: "create",
        unitType: "center",
        name: "Imaging Working Group",
        slug: "imaging-working-group",
        deptCode: "MED",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxCenterCreate).toHaveBeenCalledTimes(1);
  });
});

describe("/api/edit/unit op:'create' — coded division (Superuser only)", () => {
  it("Superuser creates a coded division with a real N-code", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const res = await POST(
      post({
        op: "create",
        unitType: "division",
        name: "Newly Coded Division",
        slug: "newly-coded",
        deptCode: "MED",
        code: "N9999",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, code: "N9999" });
    expect(mockTxDivisionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          code: "N9999",
          deptCode: "MED",
          source: "manual",
        }),
      }),
    );
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        unitKind: "division",
        parentDeptSlug: "medicine",
      }),
    );
  });

  it("Non-Superuser → 403 not_superuser (even an Owner of the parent dept)", async () => {
    const res = await POST(
      post({
        op: "create",
        unitType: "division",
        name: "Nope",
        slug: "nope",
        deptCode: "MED",
        code: "N9999",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_superuser" });
  });

  it("Invalid code format → 400 invalid_code", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const res = await POST(
      post({
        op: "create",
        unitType: "division",
        name: "X",
        slug: "x",
        deptCode: "MED",
        code: "bad code",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_code" });
  });

  it("Code already taken → 400 code_taken", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockDivisionFindUnique.mockResolvedValue({ code: "N9999" });
    const res = await POST(
      post({
        op: "create",
        unitType: "division",
        name: "X",
        slug: "x",
        deptCode: "MED",
        code: "N9999",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "code_taken" });
  });
});

describe("/api/edit/unit op:'update' — center in-row", () => {
  beforeEach(() => {
    mockCenterFindUnique.mockResolvedValue({ code: "MEYER", slug: "meyer" });
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "center", entityId: "MEYER", role: "curator" },
    ]);
  });

  it("Curator updates the center description", async () => {
    const res = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "description",
        value: "Curated center blurb",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxCenterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { code: "MEYER" },
        data: { description: "Curated center blurb" },
      }),
    );
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({ unitKind: "center", unitSlug: "meyer" }),
    );
  });

  it("Curator updates the center url (#1021)", async () => {
    const res = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "url",
        value: "https://meyer.weill.cornell.edu",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxCenterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { code: "MEYER" },
        data: { url: "https://meyer.weill.cornell.edu" },
      }),
    );
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({ unitKind: "center", unitSlug: "meyer" }),
    );
  });

  it("center url='' clears the link → null on the column (#1021)", async () => {
    const res = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "url",
        value: "",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxCenterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { url: null } }),
    );
  });

  it("center url rejects a non-https / garbage value → 400 invalid_url (#1021)", async () => {
    const http = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "url",
        value: "http://meyer.weill.cornell.edu",
      }),
    );
    expect(http.status).toBe(400);
    expect(await http.json()).toMatchObject({ ok: false, error: "invalid_url" });

    const garbage = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "url",
        value: "not a url",
      }),
    );
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ ok: false, error: "invalid_url" });
  });

  it("slug + centerType are Superuser-only — Curator gets 403 not_superuser", async () => {
    const slug = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "slug",
        value: "renamed",
      }),
    );
    expect(slug.status).toBe(403);
    expect(await slug.json()).toMatchObject({ ok: false, error: "not_superuser" });

    const ct = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "centerType",
        value: "institute",
      }),
    );
    expect(ct.status).toBe(403);
  });

  it("Superuser slug update revalidates BOTH the new and the previous slug", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const res = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "slug",
        value: "meyer-cancer-institute",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        unitKind: "center",
        unitSlug: "meyer-cancer-institute",
        previousSlug: "meyer",
      }),
    );
  });

  // #2542 contract A — leadership is an `OrgUnitRoleAssignment` row, the sole
  // store; the deprecated `Center.directorCwid` column write retired with
  // this ticket. The request contract is unchanged (same two field names,
  // same two POSTs from `unit-leader-card.tsx`).
  it("naming a director writes the assignment row and does not touch the center row", async () => {
    mockTxCenterLeaderFindFirst.mockResolvedValue(null);
    const res = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "directorCwid",
        value: "new0001",
      }),
    );
    expect(res.status).toBe(200);
    // The vocabulary is seeded first: `org_unit_role_assignment.role_key` FKs to
    // it, and it is empty until the backfill runs.
    expect(mockTxCenterRoleCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(mockTxCenterLeaderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: "center",
          entityId: "MEYER",
          cwid: "new0001",
          roleKey: "director",
        }),
      }),
    );
    expect(mockTxCenterUpdate).not.toHaveBeenCalled();
  });

  it("directorCwid='' vacates the assignment and does not touch the center row", async () => {
    mockTxCenterLeaderFindFirst.mockResolvedValue({ cwid: "dir0001", interim: false });
    const res = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "directorCwid",
        value: "",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxCenterLeaderDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType: "center", entityId: "MEYER", roleKey: "director" },
      }),
    );
    expect(mockTxCenterLeaderCreate).not.toHaveBeenCalled();
    expect(mockTxCenterUpdate).not.toHaveBeenCalled();
  });

  it("carries the incumbent's interim qualifier onto a new director", async () => {
    // `Center.leaderInterim` was a column that survived a director change, so
    // the qualifier follows the ROLE, not the person.
    mockTxCenterLeaderFindFirst.mockResolvedValue({ cwid: "old0001", interim: true });
    const res = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "directorCwid",
        value: "new0001",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxCenterLeaderCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ interim: true }) }),
    );
  });

  it("dual-reads the deprecated column for the audit before-value when no CenterLeader row exists yet", async () => {
    // The window between the ECS roll and the manual Phase 1 backfill. Without
    // the fallback the audit would record the previous director as null.
    mockTxCenterLeaderFindFirst.mockResolvedValue(null);
    mockTxCenterFindUnique.mockResolvedValue({
      name: "Meyer",
      slug: "meyer",
      description: null,
      url: null,
      centerType: "center",
      directorCwid: "legacy01",
      leaderInterim: true,
    });
    const res = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "directorCwid",
        value: "new0001",
      }),
    );
    expect(res.status).toBe(200);
    // `before_values` is the 6th bound value of the audit INSERT; arg 0 is the
    // template strings (see the `auditAfterValues` helper below).
    expect(JSON.parse(mockExecuteRaw.mock.calls[0][6] as string)).toEqual({
      directorCwid: "legacy01",
    });
  });

  it("Center not found → 400 unit_not_found", async () => {
    mockCenterFindUnique.mockResolvedValue(null);
    const res = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "GHOST",
        fieldName: "description",
        value: "x",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "unit_not_found" });
  });

  it("Non-center entityType is rejected — dept/div edits route through /api/edit/field", async () => {
    const res = await POST(
      post({
        op: "update",
        entityType: "department",
        entityId: "MED",
        fieldName: "description",
        value: "x",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_entity_type" });
  });
});

describe("/api/edit/unit op:'update' — renaming (unit name)", () => {
  beforeEach(() => {
    mockCenterFindUnique.mockResolvedValue({ code: "MEYER", slug: "meyer" });
    mockTxCenterFindUnique.mockResolvedValue({ name: "Old Center Name" });
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "center", entityId: "MEYER", role: "curator" },
    ]);
  });

  it("a Curator renames a center — name is NOT superuser-gated", async () => {
    const res = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "name",
        value: "Jill Roberts Institute for Research in Inflammatory Bowel Disease",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxCenterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { code: "MEYER" },
        data: { name: "Jill Roberts Institute for Research in Inflammatory Bowel Disease" },
      }),
    );
  });

  it("a comms steward renames a center with no unit-admin grant at all", async () => {
    // The whole point of the feature: the comms office actions a rename
    // without a code deploy and without a per-unit grant.
    mockGetEditSession.mockResolvedValue({
      cwid: "com001",
      isSuperuser: false,
      isCommsSteward: true,
    });
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "name",
        value: "Renamed By Comms",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxCenterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: "Renamed By Comms" } }),
    );
  });

  it("a user with no role cannot rename", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "name",
        value: "Nope",
      }),
    );
    expect(res.status).toBe(403);
    expect(mockTxCenterUpdate).not.toHaveBeenCalled();
  });

  it("a rename does NOT move the slug", async () => {
    await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "name",
        value: "Some New Name",
      }),
    );
    const data = mockTxCenterUpdate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("slug");
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({ unitKind: "center", unitSlug: "meyer", previousSlug: null }),
    );
  });

  it("blank and over-long names are rejected", async () => {
    const blank = await POST(
      post({ op: "update", entityType: "center", entityId: "MEYER", fieldName: "name", value: "   " }),
    );
    expect(blank.status).toBe(400);
    const long = await POST(
      post({
        op: "update",
        entityType: "center",
        entityId: "MEYER",
        fieldName: "name",
        value: "x".repeat(256),
      }),
    );
    expect(long.status).toBe(400);
    expect(await long.json()).toMatchObject({ error: "name_too_long" });
    expect(mockTxCenterUpdate).not.toHaveBeenCalled();
  });

  it("renames a MANUALLY-created division", async () => {
    mockDivisionFindUnique.mockResolvedValue({
      code: "N9999",
      slug: "cardiology",
      deptCode: "MED",
      department: { slug: "medicine" },
      source: "manual",
    });
    mockTxDivisionFindUnique.mockResolvedValue({ name: "Old Division" });
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "division", entityId: "N9999", role: "curator" },
    ]);
    const res = await POST(
      post({
        op: "update",
        entityType: "division",
        entityId: "N9999",
        fieldName: "name",
        value: "New Division Name",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxDivisionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: "N9999" }, data: { name: "New Division Name" } }),
    );
  });

  it("REFUSES to rename an ED-sourced division — the ETL owns that name", async () => {
    mockDivisionFindUnique.mockResolvedValue({
      code: "N1234",
      slug: "cardiology",
      deptCode: "MED",
      department: { slug: "medicine" },
      source: "ED",
    });
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "division", entityId: "N1234", role: "owner" },
    ]);
    const res = await POST(
      post({
        op: "update",
        entityType: "division",
        entityId: "N1234",
        fieldName: "name",
        value: "Should Not Persist",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "unit_not_manual" });
    expect(mockTxDivisionUpdate).not.toHaveBeenCalled();
  });

  it("a division exposes ONLY name — no other field is writable in-row", async () => {
    mockDivisionFindUnique.mockResolvedValue({
      code: "N9999",
      slug: "cardiology",
      deptCode: "MED",
      department: { slug: "medicine" },
      source: "manual",
    });
    const res = await POST(
      post({
        op: "update",
        entityType: "division",
        entityId: "N9999",
        fieldName: "description",
        value: "via the wrong route",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_field" });
  });

  it("a department is still rejected outright", async () => {
    const res = await POST(
      post({
        op: "update",
        entityType: "department",
        entityId: "MED",
        fieldName: "name",
        value: "Renamed Dept",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_entity_type" });
  });
});
