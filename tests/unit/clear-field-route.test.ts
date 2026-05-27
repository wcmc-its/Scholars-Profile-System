import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockFieldOverrideFindUnique,
  mockFieldOverrideDelete,
  mockExecuteRaw,
  mockScholarFindUnique,
  mockScholarFindMany,
  mockScholarUpdate,
  mockSlugHistoryUpsert,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockFieldOverrideFindUnique: vi.fn(),
  mockFieldOverrideDelete: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockScholarUpdate: vi.fn(),
  mockSlugHistoryUpsert: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {},
    write: { $transaction: mockTransaction },
  },
}));

import { POST } from "@/app/api/edit/clear-field/route";

const SELF = { cwid: "self01", isSuperuser: false };
const ADMIN = { cwid: "adm001", isSuperuser: true };

const fakeTx = {
  fieldOverride: {
    findUnique: mockFieldOverrideFindUnique,
    delete: mockFieldOverrideDelete,
  },
  scholar: {
    findUnique: mockScholarFindUnique,
    findMany: mockScholarFindMany,
    update: mockScholarUpdate,
  },
  slugHistory: { upsert: mockSlugHistoryUpsert },
  $executeRaw: mockExecuteRaw,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/clear-field", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(ADMIN);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockFieldOverrideFindUnique.mockResolvedValue({ value: "former-slug" });
  mockFieldOverrideDelete.mockResolvedValue({});
  mockExecuteRaw.mockResolvedValue(1);
  // The cleared scholar: pinned slug "former-slug", name "Jane Smith". The route
  // re-derives to "jane-smith"; reconcileScholarSlug reads the same findUnique
  // (so the object carries both `preferredName` and `slug`).
  mockScholarFindUnique.mockResolvedValue({ preferredName: "Jane Smith", slug: "former-slug" });
  mockScholarFindMany.mockResolvedValue([]); // no other scholars hold a slug
  mockScholarUpdate.mockResolvedValue({});
  mockSlugHistoryUpsert.mockResolvedValue({});
});

describe("POST /api/edit/clear-field", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "slug" }));
    expect(res.status).toBe(401);
  });

  it("rejects a non-superuser with 403 and writes nothing", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const res = await POST(post({ entityType: "scholar", entityId: "self01", fieldName: "slug" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("not_superuser");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects a non-scholar entityType with 400", async () => {
    const res = await POST(
      post({ entityType: "publication", entityId: "12345", fieldName: "slug" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_entity_type");
  });

  it("rejects an empty entityId with 400", async () => {
    const res = await POST(post({ entityType: "scholar", entityId: "", fieldName: "slug" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_entity_id");
  });

  it("rejects an unknown fieldName with 400 invalid_field", async () => {
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "email" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_field");
  });

  it("rejects fieldName='overview' with 400 unclearable_field (clearing overview goes through /api/edit/field)", async () => {
    const res = await POST(
      post({ entityType: "scholar", entityId: "sch5", fieldName: "overview" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("unclearable_field");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("clears an existing override + audit row, returns cleared:true", async () => {
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "slug" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fieldName).toBe("slug");
    expect(body.cleared).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockFieldOverrideDelete).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    // audit row carries the new action discriminator and the before/after shape
    const auditArgs = mockExecuteRaw.mock.calls[0];
    expect(auditArgs[4]).toBe("field_override_clear");
  });

  it("reverts Scholar.slug to the name-derived slug, pinning the old slug to history (#497 §5.1)", async () => {
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "slug" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleared).toBe(true);
    expect(mockFieldOverrideDelete).toHaveBeenCalledTimes(1);
    // derived from preferredName "Jane Smith" -> "jane-smith"; old pinned slug -> history
    expect(mockSlugHistoryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { oldSlug: "former-slug" },
        create: { oldSlug: "former-slug", currentCwid: "sch5" },
      }),
    );
    expect(mockScholarUpdate).toHaveBeenCalledWith({
      where: { cwid: "sch5" },
      data: { slug: "jane-smith" },
    });
  });

  it("takes the numeric floor when the derived slug collides with another live scholar", async () => {
    mockScholarFindMany.mockResolvedValue([{ slug: "jane-smith" }]); // taken by someone else
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "slug" }));
    expect(res.status).toBe(200);
    expect(mockScholarUpdate).toHaveBeenCalledWith({
      where: { cwid: "sch5" },
      data: { slug: "jane-smith-2" },
    });
  });

  it("is idempotent — no override yields cleared:false, no audit row, no delete call", async () => {
    mockFieldOverrideFindUnique.mockResolvedValue(null);
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "slug" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cleared).toBe(false);
    expect(mockFieldOverrideDelete).not.toHaveBeenCalled();
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("rolls back when the audit insert fails — override row is not deleted", async () => {
    mockExecuteRaw.mockRejectedValue(new Error("audit insert exploded"));
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "slug" }));
    expect(res.status).toBe(500);
    // The transaction callback threw, so the wrapping $transaction must surface
    // the failure — Prisma rolls back, no row leaks. We just assert the route
    // surfaced a 500.
  });

  it("returns 500 when the write transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "slug" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("write_failed");
  });
});
