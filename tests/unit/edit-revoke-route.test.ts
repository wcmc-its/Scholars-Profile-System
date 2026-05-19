import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockSuppressionFindUnique,
  mockSuppressionUpdate,
  mockSuppressionCount,
  mockScholarUpdateMany,
  mockExecuteRaw,
  mockReflectVisibilityChange,
  mockResolveProfiles,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockSuppressionFindUnique: vi.fn(),
  mockSuppressionUpdate: vi.fn(),
  mockSuppressionCount: vi.fn(),
  mockScholarUpdateMany: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockReflectVisibilityChange: vi.fn(),
  mockResolveProfiles: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/db", () => ({
  db: {
    read: { suppression: { findUnique: mockSuppressionFindUnique } },
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

import { POST } from "@/app/api/edit/revoke/route";

const SELF = { cwid: "self01", isSuperuser: false };

const fakeTx = {
  suppression: { update: mockSuppressionUpdate, count: mockSuppressionCount },
  scholar: { updateMany: mockScholarUpdateMany },
  $executeRaw: mockExecuteRaw,
};

/** A whole-scholar suppression created by SELF, not yet revoked. */
const ownScholarSuppression = {
  id: "sup-1",
  entityType: "scholar",
  entityId: "self01",
  contributorCwid: null,
  createdBy: "self01",
  revokedAt: null,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/revoke", {
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
  mockSuppressionFindUnique.mockResolvedValue(ownScholarSuppression);
  mockSuppressionUpdate.mockResolvedValue({});
  mockSuppressionCount.mockResolvedValue(0);
  mockScholarUpdateMany.mockResolvedValue({ count: 1 });
  mockExecuteRaw.mockResolvedValue(1);
  mockResolveProfiles.mockResolvedValue([{ slug: "self01-slug", cwid: "self01" }]);
});

describe("POST /api/edit/revoke", () => {
  it("returns 404 when the suppression does not exist", async () => {
    mockSuppressionFindUnique.mockResolvedValue(null);
    const res = await POST(post({ suppressionId: "missing" }));
    expect(res.status).toBe(404);
  });

  it("rejects revoking a suppression created by someone else with 403 (edge 5)", async () => {
    mockSuppressionFindUnique.mockResolvedValue({ ...ownScholarSuppression, createdBy: "adm001" });
    const res = await POST(post({ suppressionId: "sup-1" }));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("is idempotent when the suppression is already revoked", async () => {
    mockSuppressionFindUnique.mockResolvedValue({ ...ownScholarSuppression, revokedAt: new Date() });
    const res = await POST(post({ suppressionId: "sup-1" }));
    expect(res.status).toBe(200);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("revokes the row and restores status when no other suppression remains", async () => {
    mockSuppressionCount.mockResolvedValue(0);
    const res = await POST(post({ suppressionId: "sup-1" }));
    expect(res.status).toBe(200);
    expect(mockSuppressionUpdate).toHaveBeenCalledTimes(1);
    expect(mockScholarUpdateMany).toHaveBeenCalledWith({
      where: { cwid: "self01" },
      data: { status: "active" },
    });
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("revokes the row but leaves status suppressed when another suppression remains (edge 4)", async () => {
    mockSuppressionCount.mockResolvedValue(1);
    const res = await POST(post({ suppressionId: "sup-1" }));
    expect(res.status).toBe(200);
    expect(mockSuppressionUpdate).toHaveBeenCalledTimes(1);
    expect(mockScholarUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 500 when the write transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await POST(post({ suppressionId: "sup-1" }));
    expect(res.status).toBe(500);
  });

  it("rejects a missing suppressionId with 400", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
  });
});
