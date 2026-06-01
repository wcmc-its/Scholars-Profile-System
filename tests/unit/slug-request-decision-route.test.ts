/**
 * POST /api/edit/slug-request/[id]/decision — superuser approve/reject (#497 PR-3).
 * Asserts the flag/authz gates, the approve transaction (override upsert +
 * reconcile + status + B03), the required reject note, the 409 collision
 * backstop, and the best-effort requester notification.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockAppendAuditRow,
  mockIsMailerConfigured,
  mockSendMail,
  mockEnabled,
  mockReconcile,
  mockTransaction,
  mockSlugReqFindUnique,
  mockScholarFindUnique,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockIsMailerConfigured: vi.fn(),
  mockSendMail: vi.fn(),
  mockEnabled: vi.fn(),
  mockReconcile: vi.fn(),
  mockTransaction: vi.fn(),
  mockSlugReqFindUnique: vi.fn(),
  mockScholarFindUnique: vi.fn(),
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
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/edit/mailer", () => ({
  isMailerConfigured: mockIsMailerConfigured,
  sendMail: mockSendMail,
}));
vi.mock("@/lib/edit/slug-request", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/slug-request")>()),
  isSlugRequestEnabled: mockEnabled,
}));
vi.mock("@/lib/slug", () => ({ reconcileScholarSlug: mockReconcile }));
vi.mock("@/lib/db", () => ({
  db: {
    write: { $transaction: mockTransaction },
    read: {
      slugRequest: { findUnique: mockSlugReqFindUnique },
      scholar: { findUnique: mockScholarFindUnique },
    },
  },
}));

import { POST } from "@/app/api/edit/slug-request/[id]/decision/route";

const ADMIN = { cwid: "adm001", isSuperuser: true };
const SELF = { cwid: "self01", isSuperuser: false };

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/slug-request/req-1/decision", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ id: "req-1" }) };

function txStub() {
  return {
    $executeRaw: vi.fn(),
    fieldOverride: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    slugRequest: { update: vi.fn().mockResolvedValue({}) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockEnabled.mockReturnValue(true);
  mockGetEditSession.mockResolvedValue(ADMIN);
  mockSlugReqFindUnique.mockResolvedValue({
    id: "req-1",
    cwid: "c1",
    requestedSlug: "casey-one",
    status: "pending",
  });
  mockReconcile.mockResolvedValue(true);
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockIsMailerConfigured.mockReturnValue(true);
  mockSendMail.mockResolvedValue({ messageId: "m1" });
  mockScholarFindUnique.mockResolvedValue({ email: "casey@med.cornell.edu" });
  mockTransaction.mockImplementation(async (cb: (tx: ReturnType<typeof txStub>) => unknown) =>
    cb(txStub()),
  );
});

describe("POST .../decision — gates", () => {
  it("404 when the flag is off", async () => {
    mockEnabled.mockReturnValue(false);
    expect((await POST(post({ decision: "approve" }), ctx)).status).toBe(404);
  });

  it("403 for a non-superuser", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const res = await POST(post({ decision: "approve" }), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_superuser" });
  });

  it("400 for an invalid decision", async () => {
    expect((await POST(post({ decision: "maybe" }), ctx)).status).toBe(400);
  });

  it("404 when the request doesn't exist", async () => {
    mockSlugReqFindUnique.mockResolvedValue(null);
    expect((await POST(post({ decision: "approve" }), ctx)).status).toBe(404);
  });

  it("409 when the request is already decided", async () => {
    mockSlugReqFindUnique.mockResolvedValue({ id: "req-1", cwid: "c1", requestedSlug: "x", status: "approved" });
    const res = await POST(post({ decision: "approve" }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_decided" });
  });
});

describe("POST .../decision — approve", () => {
  it("writes the override + reconciles + marks approved + audits + notifies", async () => {
    const res = await POST(post({ decision: "approve" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "approved", slug: "casey-one" });
    expect(mockReconcile).toHaveBeenCalledWith(expect.anything(), "c1", "casey-one");
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({ action: "slug_request_approved" });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][0].subject).toMatch(/approved/i);
  });

  it("409 collision when the UNIQUE guard rejects the slug (taken since request)", async () => {
    mockTransaction.mockRejectedValue(Object.assign(new Error("Unique constraint"), { code: "P2002" }));
    const res = await POST(post({ decision: "approve" }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "collision" });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("still succeeds when the notification email throws (best-effort)", async () => {
    mockSendMail.mockRejectedValue(new Error("SES down"));
    const res = await POST(post({ decision: "approve" }), ctx);
    expect(res.status).toBe(200);
  });

  it("skips the email when the mailer is dormant", async () => {
    mockIsMailerConfigured.mockReturnValue(false);
    const res = await POST(post({ decision: "approve" }), ctx);
    expect(res.status).toBe(200);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

describe("POST .../decision — reject", () => {
  it("400 note_required when rejecting without a note", async () => {
    const res = await POST(post({ decision: "reject" }), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "note_required" });
  });

  it("marks rejected with the note, audits, and notifies", async () => {
    const res = await POST(post({ decision: "reject", note: "Too close to a unit name." }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "rejected" });
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({ action: "slug_request_rejected" });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][0].text).toContain("Too close to a unit name.");
  });
});
