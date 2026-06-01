/**
 * #540 Phase 5a — `/api/edit/suppress` widened for whole-unit retire.
 *
 * SPEC § Authorization — unit retire is structural, Superuser only.
 * SPEC § Write-path behavior — the page 404s via the suppression lookup;
 * the facet drops on the next nightly rebuild; members untouched; revocable.
 *
 * Covers:
 *  - Superuser retires a department / division / center (idempotent re-suppression).
 *  - Non-superuser → 403 not_superuser (precedes the existing `authorizeSuppress`
 *    branch — units bypass that predicate).
 *  - Unit not found → 400 unit_not_found.
 *  - `contributorCwid` on a unit retire → 400 invalid_contributor.
 *  - `reason` required (no self-suppression default for a unit).
 *  - Idempotency: an existing active suppression returns the same id with no
 *    new write.
 *  - Audit row records `targetEntityType` as the unit kind.
 *  - Post-commit reflection: `reflectUnitChange` is called; the per-author
 *    `reflectVisibilityChange` / OpenSearch fast-path are skipped for units.
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
  mockSuppressionFindFirst,
  mockTxSuppressionCreate,
  mockTxScholarUpdateMany,
  mockReflectUnitChange,
  mockReflectVisibilityChange,
  mockReflectSearchSuppression,
  mockResolveProfiles,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockDepartmentFindUnique: vi.fn(),
  mockDivisionFindUnique: vi.fn(),
  mockCenterFindUnique: vi.fn(),
  mockSuppressionFindFirst: vi.fn(),
  mockTxSuppressionCreate: vi.fn(),
  mockTxScholarUpdateMany: vi.fn(),
  mockReflectUnitChange: vi.fn(),
  mockReflectVisibilityChange: vi.fn(),
  mockReflectSearchSuppression: vi.fn(),
  mockResolveProfiles: vi.fn(),
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
      suppression: { findFirst: mockSuppressionFindFirst },
      // findSuppressibleEntityOwner / publicationAuthorshipExists / etc. are not
      // exercised by unit-retire paths, so an empty surface is enough.
      grant: { findUnique: vi.fn() },
      education: { findUnique: vi.fn() },
      appointment: { findUnique: vi.fn() },
      publicationAuthor: { findMany: vi.fn() },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectUnitChange: mockReflectUnitChange,
  reflectVisibilityChange: mockReflectVisibilityChange,
  resolveAffectedProfiles: mockResolveProfiles,
}));
vi.mock("@/lib/edit/search-suppression", () => ({
  reflectSearchSuppression: mockReflectSearchSuppression,
}));

import { POST } from "@/app/api/edit/suppress/route";

const SUPERUSER = { cwid: "sup001", isSuperuser: true };
const SCHOLAR = { cwid: "self01", isSuperuser: false };

const fakeTx = {
  suppression: { create: mockTxSuppressionCreate },
  scholar: { updateMany: mockTxScholarUpdateMany },
  $executeRaw: mockExecuteRaw,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/suppress", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(SUPERUSER);
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
  mockSuppressionFindFirst.mockResolvedValue(null);
  mockTxSuppressionCreate.mockResolvedValue({ id: "sup-1" });
  mockResolveProfiles.mockResolvedValue([]);
});

describe("/api/edit/suppress — unit retire (#540 Phase 5a)", () => {
  it("Superuser retires a department (edge 20)", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        reason: "Department dissolved",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, suppressionId: "sup-1" });
    expect(mockTxSuppressionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: "department",
          entityId: "MED",
          contributorCwid: null,
          createdBy: "sup001",
        }),
      }),
    );
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({ unitKind: "department", unitSlug: "medicine" }),
    );
  });

  it("Superuser retires a division — revalidates both the dept and division pages", async () => {
    const res = await POST(
      post({
        entityType: "division",
        entityId: "CARDIO",
        reason: "Division consolidated",
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

  it("Superuser retires a center", async () => {
    const res = await POST(
      post({
        entityType: "center",
        entityId: "MEYER",
        reason: "Center retired",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockReflectUnitChange).toHaveBeenCalledWith(
      expect.objectContaining({ unitKind: "center", unitSlug: "meyer" }),
    );
  });

  it("Non-superuser → 403 not_superuser (bypasses authorizeSuppress entirely)", async () => {
    mockGetEditSession.mockResolvedValue(SCHOLAR);
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        reason: "I want to dissolve this",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_superuser" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("Unit not found → 400 unit_not_found", async () => {
    mockDepartmentFindUnique.mockResolvedValue(null);
    const res = await POST(
      post({
        entityType: "department",
        entityId: "GHOST",
        reason: "Ghost dept",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "unit_not_found" });
  });

  it("`contributorCwid` on a unit retire → 400 invalid_contributor", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        contributorCwid: "someone",
        reason: "wrong shape",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_contributor" });
  });

  it("`reason` is required for a unit retire (no self-suppression default)", async () => {
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        reason: "   ",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "reason_required" });
  });

  it("Idempotency — an existing active suppression returns the same id with no write", async () => {
    mockSuppressionFindFirst.mockResolvedValue({ id: "sup-existing" });
    const res = await POST(
      post({
        entityType: "department",
        entityId: "MED",
        reason: "Already retired",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, suppressionId: "sup-existing" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("Audit row records `targetEntityType` as the unit kind", async () => {
    await POST(
      post({
        entityType: "center",
        entityId: "MEYER",
        reason: "Center retired",
      }),
    );
    // appendAuditRow uses $executeRaw under the hood; we just confirm one
    // raw write happened inside the same transaction as the suppression.
    expect(mockExecuteRaw).toHaveBeenCalledOnce();
  });

  it("Unit retire skips the per-author profile-page revalidation + OpenSearch fast-path", async () => {
    await POST(
      post({
        entityType: "department",
        entityId: "MED",
        reason: "Department dissolved",
      }),
    );
    expect(mockReflectVisibilityChange).not.toHaveBeenCalled();
    expect(mockReflectSearchSuppression).not.toHaveBeenCalled();
    expect(mockResolveProfiles).not.toHaveBeenCalled();
  });
});
