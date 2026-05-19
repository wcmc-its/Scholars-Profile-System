import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockFieldOverrideFindUnique,
  mockFieldOverrideUpsert,
  mockExecuteRaw,
  mockScholarFindFirst,
  mockFieldOverrideFindFirst,
  mockSlugHistoryFindFirst,
  mockReflectOverviewEdit,
  mockResolveSlugs,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockFieldOverrideFindUnique: vi.fn(),
  mockFieldOverrideUpsert: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockScholarFindFirst: vi.fn(),
  mockFieldOverrideFindFirst: vi.fn(),
  mockSlugHistoryFindFirst: vi.fn(),
  mockReflectOverviewEdit: vi.fn(),
  mockResolveSlugs: vi.fn(),
}));

vi.mock("@/lib/auth/superuser", () => ({ getEditSession: mockGetEditSession }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findFirst: mockScholarFindFirst },
      fieldOverride: { findFirst: mockFieldOverrideFindFirst },
      slugHistory: { findFirst: mockSlugHistoryFindFirst },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectOverviewEdit: mockReflectOverviewEdit,
  resolveAffectedProfileSlugs: mockResolveSlugs,
}));

import { POST } from "@/app/api/edit/field/route";

const SELF = { cwid: "self01", isSuperuser: false };
const ADMIN = { cwid: "adm001", isSuperuser: true };

const fakeTx = {
  fieldOverride: { findUnique: mockFieldOverrideFindUnique, upsert: mockFieldOverrideUpsert },
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
  mockGetEditSession.mockResolvedValue(SELF);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockFieldOverrideFindUnique.mockResolvedValue(null);
  mockFieldOverrideUpsert.mockResolvedValue({});
  mockExecuteRaw.mockResolvedValue(1);
  mockScholarFindFirst.mockResolvedValue(null);
  mockFieldOverrideFindFirst.mockResolvedValue(null);
  mockSlugHistoryFindFirst.mockResolvedValue(null);
  mockResolveSlugs.mockResolvedValue(["self01-slug"]);
});

describe("POST /api/edit/field", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await POST(post({ entityType: "scholar", entityId: "self01", fieldName: "overview", value: "<p>x</p>" }));
    expect(res.status).toBe(401);
  });

  it("rejects a cross-scholar overview edit with 403 and writes nothing", async () => {
    const res = await POST(post({ entityType: "scholar", entityId: "other9", fieldName: "overview", value: "<p>x</p>" }));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects an unknown fieldName with 400", async () => {
    const res = await POST(post({ entityType: "scholar", entityId: "self01", fieldName: "email", value: "x" }));
    expect(res.status).toBe(400);
  });

  it("rejects a slug edit by a non-superuser with 403", async () => {
    const res = await POST(post({ entityType: "scholar", entityId: "self01", fieldName: "slug", value: "new-slug" }));
    expect(res.status).toBe(403);
  });

  it("rejects an oversized overview with 400", async () => {
    const res = await POST(
      post({ entityType: "scholar", entityId: "self01", fieldName: "overview", value: `<p>${"a".repeat(25_000)}</p>` }),
    );
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("sanitizes a valid overview, writes one transaction + audit row, returns the sanitized value", async () => {
    const res = await POST(
      post({ entityType: "scholar", entityId: "self01", fieldName: "overview", value: "<p>Hi<script>evil()</script></p>" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fieldName).toBe("overview");
    expect(body.value).not.toContain("script");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockFieldOverrideUpsert).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // the B03 audit row
    expect(mockReflectOverviewEdit).toHaveBeenCalled();
  });

  it("returns 500 when the write transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await POST(post({ entityType: "scholar", entityId: "self01", fieldName: "overview", value: "<p>x</p>" }));
    expect(res.status).toBe(500);
  });

  it("allows a superuser slug edit when the slug is free", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "slug", value: "new-slug" }));
    expect(res.status).toBe(200);
    expect(mockReflectOverviewEdit).not.toHaveBeenCalled(); // slug reflects nothing at write time
  });

  it("rejects a colliding slug with 400", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockScholarFindFirst.mockResolvedValue({ cwid: "other" });
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "slug", value: "taken" }));
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
