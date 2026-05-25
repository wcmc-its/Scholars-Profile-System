import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockSuppressionFindFirst,
  mockPublicationAuthorFindFirst,
  mockSuppressionCreate,
  mockScholarUpdateMany,
  mockExecuteRaw,
  mockReflectVisibilityChange,
  mockResolveProfiles,
  mockGrantFindUnique,
  mockEducationFindUnique,
  mockAppointmentFindUnique,
  mockDepartmentFindFirst,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockSuppressionFindFirst: vi.fn(),
  mockPublicationAuthorFindFirst: vi.fn(),
  mockSuppressionCreate: vi.fn(),
  mockScholarUpdateMany: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockReflectVisibilityChange: vi.fn(),
  mockResolveProfiles: vi.fn(),
  mockGrantFindUnique: vi.fn(),
  mockEducationFindUnique: vi.fn(),
  mockAppointmentFindUnique: vi.fn(),
  mockDepartmentFindFirst: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      suppression: { findFirst: mockSuppressionFindFirst },
      publicationAuthor: { findFirst: mockPublicationAuthorFindFirst },
      grant: { findUnique: mockGrantFindUnique },
      education: { findUnique: mockEducationFindUnique },
      appointment: { findUnique: mockAppointmentFindUnique },
      department: { findFirst: mockDepartmentFindFirst },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectVisibilityChange: mockReflectVisibilityChange,
  resolveAffectedProfiles: mockResolveProfiles,
}));
vi.mock("@/lib/edit/search-suppression", () => ({
  reflectSearchSuppression: vi.fn(),
}));

import { POST } from "@/app/api/edit/suppress/route";

const SELF = { cwid: "self01", isSuperuser: false };
const ADMIN = { cwid: "adm001", isSuperuser: true };

const fakeTx = {
  suppression: { create: mockSuppressionCreate },
  scholar: { updateMany: mockScholarUpdateMany },
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
  mockGetEditSession.mockResolvedValue(SELF);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockSuppressionFindFirst.mockResolvedValue(null);
  mockPublicationAuthorFindFirst.mockResolvedValue({ id: "pa1" });
  mockSuppressionCreate.mockResolvedValue({ id: "sup-1" });
  mockScholarUpdateMany.mockResolvedValue({ count: 1 });
  mockExecuteRaw.mockResolvedValue(1);
  mockResolveProfiles.mockResolvedValue([{ slug: "self01-slug", cwid: "self01" }]);
  // Whole-entity lookups (#160) — default: owned by self01, no chair role.
  mockGrantFindUnique.mockResolvedValue({ cwid: "self01" });
  mockEducationFindUnique.mockResolvedValue({ cwid: "self01" });
  mockAppointmentFindUnique.mockResolvedValue({ cwid: "self01", title: "Professor of Medicine" });
  mockDepartmentFindFirst.mockResolvedValue(null);
});

describe("POST /api/edit/suppress", () => {
  it("rejects suppressing another scholar's profile (non-superuser) with 403", async () => {
    const res = await POST(post({ entityType: "scholar", entityId: "other9", reason: "x" }));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects an unknown entityType with 400", async () => {
    const res = await POST(post({ entityType: "topic", entityId: "t1", reason: "x" }));
    expect(res.status).toBe(400);
  });

  it("requires a reason for a superuser suppression", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(post({ entityType: "scholar", entityId: "sch9" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "reason_required" });
  });

  it("self-suppresses with a defaulted reason, projects status, and logs self_suppression", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(post({ entityType: "scholar", entityId: "self01" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, suppressionId: "sup-1" });
    expect(mockScholarUpdateMany).toHaveBeenCalledWith({
      where: { cwid: "self01" },
      data: { status: "suppressed" },
    });
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some(([line]) => String(line).includes("self_suppression"))).toBe(true);
  });

  it("is an idempotent no-op when an un-revoked suppression already exists (edge 19)", async () => {
    mockSuppressionFindFirst.mockResolvedValue({ id: "existing-1" });
    const res = await POST(post({ entityType: "scholar", entityId: "self01" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, suppressionId: "existing-1" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects a per-author hide with no authorship row with 400 (edge 18)", async () => {
    mockPublicationAuthorFindFirst.mockResolvedValue(null);
    const res = await POST(post({ entityType: "publication", entityId: "999", contributorCwid: "self01" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_authorship" });
  });

  it("rejects hiding another scholar as a contributor with 403 (edge 17)", async () => {
    const res = await POST(post({ entityType: "publication", entityId: "999", contributorCwid: "other9" }));
    expect(res.status).toBe(403);
  });

  it("writes a per-author publication hide without touching Scholar.status", async () => {
    const res = await POST(post({ entityType: "publication", entityId: "999", contributorCwid: "self01" }));
    expect(res.status).toBe(200);
    expect(mockSuppressionCreate).toHaveBeenCalledTimes(1);
    expect(mockScholarUpdateMany).not.toHaveBeenCalled();
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects a scholar suppression carrying a contributorCwid with 400", async () => {
    const res = await POST(post({ entityType: "scholar", entityId: "self01", contributorCwid: "self01" }));
    expect(res.status).toBe(400);
  });

  // --- whole-entity types: education / appointment (#160 PR-A) ---

  it("self-suppresses an education entry (200, no Scholar.status projection)", async () => {
    const res = await POST(post({ entityType: "education", entityId: "EDU-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, suppressionId: "sup-1" });
    expect(mockSuppressionCreate).toHaveBeenCalledTimes(1);
    expect(mockScholarUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects suppressing another scholar's education with 403", async () => {
    mockEducationFindUnique.mockResolvedValue({ cwid: "other9" });
    const res = await POST(post({ entityType: "education", entityId: "EDU-1" }));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects an education externalId that does not exist with 400 (entity_not_found)", async () => {
    mockEducationFindUnique.mockResolvedValue(null);
    const res = await POST(post({ entityType: "education", entityId: "MISSING" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "entity_not_found" });
  });

  it("self-suppresses a non-leadership appointment (200)", async () => {
    const res = await POST(post({ entityType: "appointment", entityId: "APPT-1" }));
    expect(res.status).toBe(200);
    expect(mockSuppressionCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses to suppress a chair appointment with 409 (D-leader), even for the chair themselves", async () => {
    mockAppointmentFindUnique.mockResolvedValue({ cwid: "self01", title: "Chair of Medicine" });
    mockDepartmentFindFirst.mockResolvedValue({ name: "Medicine" });
    const res = await POST(post({ entityType: "appointment", entityId: "APPT-CHAIR" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "leadership_appointment_not_suppressible" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("refuses a chair appointment takedown even for a superuser (guard precedes authz)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockAppointmentFindUnique.mockResolvedValue({ cwid: "other9", title: "Chair of Medicine" });
    mockDepartmentFindFirst.mockResolvedValue({ name: "Medicine" });
    const res = await POST(post({ entityType: "appointment", entityId: "APPT-CHAIR", reason: "x" }));
    expect(res.status).toBe(409);
  });

  it("rejects an education suppression carrying a contributorCwid with 400", async () => {
    const res = await POST(
      post({ entityType: "education", entityId: "EDU-1", contributorCwid: "self01" }),
    );
    expect(res.status).toBe(400);
  });

  it("lets a superuser suppress another scholar's (non-leadership) appointment", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockAppointmentFindUnique.mockResolvedValue({ cwid: "other9", title: "Professor of Medicine" });
    const res = await POST(
      post({ entityType: "appointment", entityId: "APPT-1", reason: "stale entry" }),
    );
    expect(res.status).toBe(200);
  });

  // --- grant (#160 PR-B): per-investigator role, no contributor, no chair guard ---

  it("self-suppresses a grant role (200, no Scholar.status projection)", async () => {
    const res = await POST(post({ entityType: "grant", entityId: "INFOED-1-self01" }));
    expect(res.status).toBe(200);
    expect(mockSuppressionCreate).toHaveBeenCalledTimes(1);
    expect(mockScholarUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects suppressing another scholar's grant with 403", async () => {
    mockGrantFindUnique.mockResolvedValue({ cwid: "other9" });
    const res = await POST(post({ entityType: "grant", entityId: "INFOED-1-other9" }));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects a grant externalId that does not exist with 400 (entity_not_found)", async () => {
    mockGrantFindUnique.mockResolvedValue(null);
    const res = await POST(post({ entityType: "grant", entityId: "MISSING" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "entity_not_found" });
  });

  it("rejects a grant suppression carrying a contributorCwid with 400 (row is per-investigator)", async () => {
    const res = await POST(
      post({ entityType: "grant", entityId: "INFOED-1-self01", contributorCwid: "self01" }),
    );
    expect(res.status).toBe(400);
  });
});
