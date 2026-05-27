/**
 * POST /api/edit/slug-request/[id]/withdraw — self-only cancel of a pending
 * request (#497 PR-3). Asserts the flag gate, self-only authz, the pending-only
 * rule, and the B03 row.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockAppendAuditRow,
  mockEnabled,
  mockTransaction,
  mockSlugReqFindUnique,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockEnabled: vi.fn(),
  mockTransaction: vi.fn(),
  mockSlugReqFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/edit/slug-request", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/slug-request")>()),
  isSlugRequestEnabled: mockEnabled,
}));
vi.mock("@/lib/db", () => ({
  db: {
    write: { $transaction: mockTransaction },
    read: { slugRequest: { findUnique: mockSlugReqFindUnique } },
  },
}));

import { POST } from "@/app/api/edit/slug-request/[id]/withdraw/route";

const SELF = { cwid: "self01", isSuperuser: false };

function post(): NextRequest {
  return new NextRequest("http://localhost/api/edit/slug-request/req-1/withdraw", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: "{}",
  });
}
const ctx = { params: Promise.resolve({ id: "req-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockEnabled.mockReturnValue(true);
  mockGetEditSession.mockResolvedValue(SELF);
  mockSlugReqFindUnique.mockResolvedValue({
    id: "req-1",
    cwid: "self01",
    requestedSlug: "jane-smith",
    status: "pending",
    requestedBy: "self01",
  });
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(
    async (cb: (tx: { $executeRaw: () => void; slugRequest: { update: () => Promise<unknown> } }) => unknown) =>
      cb({ $executeRaw: vi.fn(), slugRequest: { update: vi.fn().mockResolvedValue({}) } }),
  );
});

describe("POST .../withdraw", () => {
  it("404 when the flag is off", async () => {
    mockEnabled.mockReturnValue(false);
    expect((await POST(post(), ctx)).status).toBe(404);
  });

  it("404 when the request doesn't exist", async () => {
    mockSlugReqFindUnique.mockResolvedValue(null);
    expect((await POST(post(), ctx)).status).toBe(404);
  });

  it("403 when withdrawing someone else's request", async () => {
    mockSlugReqFindUnique.mockResolvedValue({
      id: "req-1",
      cwid: "other9",
      requestedSlug: "x",
      status: "pending",
      requestedBy: "other9",
    });
    const res = await POST(post(), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
  });

  it("409 when the request is not pending", async () => {
    mockSlugReqFindUnique.mockResolvedValue({
      id: "req-1",
      cwid: "self01",
      requestedSlug: "x",
      status: "approved",
      requestedBy: "self01",
    });
    const res = await POST(post(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_pending" });
  });

  it("withdraws a pending request and writes a B03 row", async () => {
    const res = await POST(post(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "req-1", status: "withdrawn" });
    expect(mockAppendAuditRow.mock.calls[0][1]).toMatchObject({ action: "slug_request_withdrawn" });
  });
});
