/**
 * /api/edit/slug-request — POST (file a request) + GET (superuser queue),
 * #497 PR-3. Mirrors the request-change-route mocking. The validator + rate-limit
 * mechanisms are unit-tested elsewhere; here they're mocked to assert the route's
 * gates (flag, authz, supersede, rate-limit, audit, warnings).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockAppendAuditRow,
  mockRecordAttempt,
  mockValidate,
  mockCheckCollision,
  mockEnabled,
  mockTransaction,
  mockScholarFindUnique,
  mockScholarFindFirst,
  mockSlugReqFindMany,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockRecordAttempt: vi.fn(),
  mockValidate: vi.fn(),
  mockCheckCollision: vi.fn(),
  mockEnabled: vi.fn(),
  mockTransaction: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarFindFirst: vi.fn(),
  mockSlugReqFindMany: vi.fn(),
}));

// The GET path calls `getEditSession` directly; the POST path resolves identity
// through `readEditRequest` → the #637 effective-identity seam. Drive BOTH from
// the same `mockGetEditSession` knob (non-impersonating: real == effective).
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
vi.mock("@/lib/edit/rate-limit", () => ({ recordRequestChangeAttempt: mockRecordAttempt }));
vi.mock("@/lib/edit/slug-request", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/slug-request")>()),
  isSlugRequestEnabled: mockEnabled,
}));
vi.mock("@/lib/edit/validators", () => ({
  validateRequestedSlug: mockValidate,
  checkSlugCollision: mockCheckCollision,
  RESERVED_SLUGS: new Set(["reserved-word"]),
}));
vi.mock("@/lib/db", () => ({
  db: {
    write: { $transaction: mockTransaction },
    read: {
      scholar: { findUnique: mockScholarFindUnique, findFirst: mockScholarFindFirst },
      slugRequest: { findMany: mockSlugReqFindMany },
    },
  },
}));

import { GET, POST } from "@/app/api/edit/slug-request/route";

const SELF = { cwid: "self01", isSuperuser: false };
const ADMIN = { cwid: "adm001", isSuperuser: true };

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/slug-request", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}
function get(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/edit/slug-request${qs}`, { method: "GET" });
}

// A tx whose slugRequest ops resolve; appendAuditRow is mocked so $executeRaw is unused.
function txStub() {
  return {
    $executeRaw: vi.fn(),
    slugRequest: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: "req-1" }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockEnabled.mockReturnValue(true);
  mockGetEditSession.mockResolvedValue(SELF);
  mockValidate.mockReturnValue({ ok: true, value: "jane-smith" });
  mockCheckCollision.mockResolvedValue({ ok: true });
  mockScholarFindUnique.mockResolvedValue(null); // no current slug by default
  mockScholarFindFirst.mockResolvedValue(null); // no colliding live holder by default
  mockRecordAttempt.mockResolvedValue({ allowed: true, count: 1, limit: 20 });
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (cb: (tx: ReturnType<typeof txStub>) => unknown) =>
    cb(txStub()),
  );
});

describe("POST /api/edit/slug-request", () => {
  it("404 when the feature flag is off", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await POST(post({ requestedSlug: "jane-smith" }));
    expect(res.status).toBe(404);
  });

  it("files a pending request, supersedes prior pending, writes a B03 row", async () => {
    const res = await POST(post({ requestedSlug: "jane-smith", reason: "known professionally" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "req-1", status: "pending", requestedSlug: "jane-smith" });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockAppendAuditRow).toHaveBeenCalledTimes(1);
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({ action: "slug_request", targetEntityId: "self01" });
  });

  it("400 invalid_slug when requestedSlug isn't a string", async () => {
    const res = await POST(post({ requestedSlug: 123 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_slug" });
  });

  it("surfaces a validation error (e.g. reserved) as 400", async () => {
    mockValidate.mockReturnValue({ ok: false, error: "reserved" });
    const res = await POST(post({ requestedSlug: "search" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "reserved", field: "requestedSlug" });
  });

  it("400 already_current when the slug is the scholar's live slug", async () => {
    mockScholarFindUnique.mockResolvedValue({ slug: "jane-smith" });
    const res = await POST(post({ requestedSlug: "jane-smith" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "already_current" });
  });

  it("400 collision when the slug is taken by another scholar", async () => {
    mockCheckCollision.mockResolvedValue({ ok: false, error: "collision" });
    const res = await POST(post({ requestedSlug: "jane-smith" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "collision" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("429 when rate-limited; no write", async () => {
    mockRecordAttempt.mockResolvedValue({ allowed: false, count: 21, limit: 20, retryAfterSeconds: 1800 });
    const res = await POST(post({ requestedSlug: "jane-smith" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1800");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("exempts superusers from the rate limit", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(post({ requestedSlug: "jane-smith" }));
    expect(res.status).toBe(200);
    expect(mockRecordAttempt).not.toHaveBeenCalled();
  });
});

describe("GET /api/edit/slug-request (queue)", () => {
  it("404 when the feature flag is off", async () => {
    mockEnabled.mockReturnValue(false);
    expect((await GET(get("?status=pending"))).status).toBe(404);
  });

  it("403 for a non-superuser", async () => {
    const res = await GET(get("?status=pending"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_superuser" });
  });

  it("400 for a non-pending status filter", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    expect((await GET(get("?status=approved"))).status).toBe(400);
  });

  it("returns the pending queue with name, current slug, and a collision warning", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockSlugReqFindMany.mockResolvedValue([
      { id: "r1", cwid: "c1", requestedSlug: "taken-slug", reason: "why", createdAt: new Date("2026-05-27T00:00:00Z") },
    ]);
    mockScholarFindUnique.mockResolvedValue({ slug: "c-one", preferredName: "Casey One", fullName: "Casey N. One" });
    mockCheckCollision.mockResolvedValue({ ok: false, error: "collision" });
    mockScholarFindFirst.mockResolvedValue({ cwid: "holder9" });
    const res = await GET(get("?status=pending"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({
      id: "r1",
      requestedSlug: "taken-slug",
      currentSlug: "c-one",
      name: "Casey One",
      warning: "collision",
      collidesWith: "holder9",
    });
  });

  it("flags a reserved requested slug without a collision lookup", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockSlugReqFindMany.mockResolvedValue([
      { id: "r2", cwid: "c2", requestedSlug: "reserved-word", reason: null, createdAt: new Date() },
    ]);
    mockScholarFindUnique.mockResolvedValue({ slug: "c-two", preferredName: "Two", fullName: null });
    const res = await GET(get("?status=pending"));
    const body = await res.json();
    expect(body.requests[0].warning).toBe("reserved");
    expect(mockCheckCollision).not.toHaveBeenCalled();
  });
});
