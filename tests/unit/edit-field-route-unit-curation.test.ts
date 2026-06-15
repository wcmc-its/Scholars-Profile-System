/**
 * #540 Phase 5a — `/api/edit/field` widened for dept/div unit fields.
 *
 * Covers:
 *  - Curator can set `description` / `leaderCwid` / `leaderInterim` on a
 *    department or a division (with the dept→division cascade).
 *  - Slug is Superuser-only (SPEC § Authorization).
 *  - A non-admin who is neither Curator nor Superuser → `403 not_curator`.
 *  - Unit not found → `400 unit_not_found` (precedes the 403).
 *  - `op:"clear"` deletes the override + emits `field_override_clear`.
 *  - `op:"clear"` on a non-existent row → 200 no-op, no audit row.
 *  - Three-state vacancy: `leaderCwid: ""` is accepted (curator vacancy).
 *  - Per-field validation: bad CWID / bad leaderInterim / too-long description.
 *  - Center entityType is rejected here — center fields go through Phase 5b's
 *    `/api/edit/unit op:"update"`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockFieldOverrideFindUnique,
  mockFieldOverrideUpsert,
  mockFieldOverrideDelete,
  mockExecuteRaw,
  mockDepartmentFindUnique,
  mockDivisionFindUnique,
  mockCenterFindUnique,
  mockUnitAdminFindMany,
  mockReflectUnitChange,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockFieldOverrideFindUnique: vi.fn(),
  mockFieldOverrideUpsert: vi.fn(),
  mockFieldOverrideDelete: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockDepartmentFindUnique: vi.fn(),
  mockDivisionFindUnique: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
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
      unitAdmin: { findMany: mockUnitAdminFindMany },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectOverviewEdit: vi.fn(),
  reflectUnitChange: mockReflectUnitChange,
  resolveAffectedProfiles: vi.fn().mockResolvedValue([]),
}));

import { POST } from "@/app/api/edit/field/route";

const CURATOR = { cwid: "cur001", isSuperuser: false };
const NONADMIN = { cwid: "non001", isSuperuser: false };
const SUPERUSER = { cwid: "sup001", isSuperuser: true };

const fakeTx = {
  fieldOverride: {
    findUnique: mockFieldOverrideFindUnique,
    upsert: mockFieldOverrideUpsert,
    delete: mockFieldOverrideDelete,
  },
  $executeRaw: mockExecuteRaw,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/field", {
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
  mockFieldOverrideFindUnique.mockResolvedValue(null);
  mockFieldOverrideUpsert.mockResolvedValue({});
  mockFieldOverrideDelete.mockResolvedValue({});
  mockExecuteRaw.mockResolvedValue(1);
  mockDepartmentFindUnique.mockResolvedValue({ code: "MED", slug: "medicine" });
  mockDivisionFindUnique.mockResolvedValue({
    code: "CARDIO",
    slug: "cardiology",
    deptCode: "MED",
    department: { slug: "medicine" },
  });
  mockCenterFindUnique.mockResolvedValue({ code: "MEYER", slug: "meyer" });
  // Default: actor is a curator of MED.
  mockUnitAdminFindMany.mockResolvedValue([
    { entityType: "department", entityId: "MED", role: "curator" },
  ]);
});

describe("/api/edit/field — unit-curation widening (#540 Phase 5a)", () => {
  it("Curator can set a dept description", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "description",
        value: "A curated description.",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockFieldOverrideUpsert).toHaveBeenCalledOnce();
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({ unitKind: "department", unitSlug: "medicine" }),
    );
  });

  it("Curator-on-dept cascades to a division (description on CARDIO succeeds)", async () => {
    const res = await POST(
      post({
        entityType: "division",
        entityId: "CARDIO",
        fieldName: "description",
        value: "Division blurb.",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUnitAdminFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          cwid: "cur001",
          OR: expect.arrayContaining([
            { entityType: "division", entityId: "CARDIO" },
            { entityType: "department", entityId: "MED" },
          ]),
        }),
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

  it("Curator can set a dept url (#1021)", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "url",
        value: "https://medicine.weill.cornell.edu",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockFieldOverrideUpsert).toHaveBeenCalledOnce();
    const upsertCall = mockFieldOverrideUpsert.mock.calls[0][0];
    expect(upsertCall.create.value).toBe("https://medicine.weill.cornell.edu");
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({ unitKind: "department", unitSlug: "medicine" }),
    );
  });

  it("Curator-on-dept cascades to a division url (#1021)", async () => {
    const res = await POST(
      post({
        entityType: "division",
        entityId: "CARDIO",
        fieldName: "url",
        value: "https://cardiology.weill.cornell.edu",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        unitKind: "division",
        unitSlug: "cardiology",
        parentDeptSlug: "medicine",
      }),
    );
  });

  it("url rejects a non-https value → 400 invalid_url (#1021)", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "url",
        value: "http://medicine.weill.cornell.edu",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_url" });
    expect(mockFieldOverrideUpsert).not.toHaveBeenCalled();
  });

  it("url rejects a garbage value → 400 invalid_url (#1021)", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "url",
        value: "not a url at all",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_url" });
  });

  it("url value=\"\" is accepted — clears the link (#1021)", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "url",
        value: "",
      }),
    );
    expect(res.status).toBe(200);
    const upsertCall = mockFieldOverrideUpsert.mock.calls[0][0];
    expect(upsertCall.create.value).toBe("");
  });

  it("Non-admin gets 403 not_curator (audit not consulted)", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "description",
        value: "x",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_curator" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("Superuser bypasses unit_admin lookup for description", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockUnitAdminFindMany.mockResolvedValue([]); // no grants
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "description",
        value: "Set by Superuser",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("slug field is Superuser-only — a Curator gets 403 not_superuser", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "slug",
        value: "medicine-special",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_superuser" });
    expect(mockTransaction).not.toHaveBeenCalled();
    // Slug never short-circuits unit_admin lookup either — superuser arm is the
    // ONLY gate (SPEC § Authorization, structural row).
  });

  it("Superuser can set a dept slug; no immediate revalidation (rides next etl/ed)", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "slug",
        value: "weill-medicine",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockReflectUnitChange).not.toHaveBeenCalled();
  });

  it("Unit not found → 400 unit_not_found (precedes the 403)", async () => {
    mockDepartmentFindUnique.mockResolvedValue(null);
    const res = await POST(
      post({
        entityType: "department",
        entityId: "GHOST",
        fieldName: "description",
        value: "x",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "unit_not_found" });
    expect(mockUnitAdminFindMany).not.toHaveBeenCalled();
  });

  it("Center entityType is rejected — centers edit in-row (Phase 5b)", async () => {
    const res = await POST(
      post({
        entityType: "center",
        entityId: "MEYER",
        fieldName: "description",
        value: "x",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_entity_type" });
  });

  it("op:\"clear\" deletes the override + emits field_override_clear", async () => {
    mockFieldOverrideFindUnique.mockResolvedValue({ value: "previous" });
    const res = await POST(
      post({
        op: "clear",
        entityType: "department",
        entityId: "MED",
        fieldName: "leaderCwid",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockFieldOverrideDelete).toHaveBeenCalledOnce();
    expect(mockExecuteRaw).toHaveBeenCalledOnce(); // audit row
  });

  it("op:\"clear\" on a non-existent row → 200 no-op, no audit row", async () => {
    mockFieldOverrideFindUnique.mockResolvedValue(null);
    const res = await POST(
      post({
        op: "clear",
        entityType: "department",
        entityId: "MED",
        fieldName: "leaderCwid",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockFieldOverrideDelete).not.toHaveBeenCalled();
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("leaderCwid value=\"\" is accepted — explicit vacancy (three-state)", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "leaderCwid",
        value: "",
      }),
    );
    expect(res.status).toBe(200);
    const upsertCall = mockFieldOverrideUpsert.mock.calls[0][0];
    expect(upsertCall.create.value).toBe("");
  });

  it("leaderCwid with invalid format → 400 invalid_cwid", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "leaderCwid",
        value: "NotACwid!!",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_cwid" });
  });

  it("leaderInterim must be exactly 'true' or 'false'", async () => {
    const bad = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "leaderInterim",
        value: "maybe",
      }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false, error: "invalid_leader_interim" });

    const good = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "leaderInterim",
        value: "true",
      }),
    );
    expect(good.status).toBe(200);
  });

  it("description over 4000 chars → 400 description_too_long", async () => {
    const tooLong = "x".repeat(4001);
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "description",
        value: tooLong,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "description_too_long",
    });
  });

  it("unrecognized fieldName → 400 invalid_field", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        fieldName: "futureField",
        value: "x",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_field" });
  });

  it("scholar entityType still works unchanged — op:'clear' rejected for scholar", async () => {
    const res = await POST(
      post({
        op: "clear",
        entityType: "scholar",
        entityId: "self01",
        fieldName: "overview",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_op" });
  });
});
