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
 *
 *  - `op:"update"` (center in-row):
 *      - Curator edits description; success + reflectUnitChange.
 *      - slug + centerType are Superuser-only.
 *      - Slug update revalidates the old slug too (previousSlug).
 *      - directorCwid="" stores null (explicit vacancy).
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

  it("directorCwid='' stores null on the column (explicit vacancy)", async () => {
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
    expect(mockTxCenterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { directorCwid: null } }),
    );
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
