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
  mockCenterFindUnique,
  mockDivisionFindFirst,
  mockUnitAdminFindMany,
  mockTxCenterCreate,
  mockTxDivisionCreate,
  mockTxCenterFindUnique,
  mockTxCenterUpdate,
  mockReflectUnitChange,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockDepartmentFindUnique: vi.fn(),
  mockDivisionFindUnique: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockDivisionFindFirst: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockTxCenterCreate: vi.fn(),
  mockTxDivisionCreate: vi.fn(),
  mockTxCenterFindUnique: vi.fn(),
  mockTxCenterUpdate: vi.fn(),
  mockReflectUnitChange: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
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
  division: { create: mockTxDivisionCreate },
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
