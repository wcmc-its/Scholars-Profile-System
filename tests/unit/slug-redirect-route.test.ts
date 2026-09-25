/**
 * POST /api/edit/slug-redirect — remove one former-URL redirect (`slug_history`
 * row) from the Profile URLs registry. Covers authn/authz, body validation,
 * not-found (incl. the concurrent-remove race), the happy path's delete + B03
 * audit row, and a failed transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockHistoryFindUnique,
  mockHistoryDeleteMany,
  mockExecuteRaw,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockHistoryFindUnique: vi.fn(),
  mockHistoryDeleteMany: vi.fn(),
  mockExecuteRaw: vi.fn(),
}));

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
  db: { read: {}, write: { $transaction: mockTransaction } },
}));

import { POST } from "@/app/api/edit/slug-redirect/route";

const USER = { cwid: "usr001", isSuperuser: false };
const ADMIN = { cwid: "adm001", isSuperuser: true };

const fakeTx = {
  slugHistory: { findUnique: mockHistoryFindUnique, deleteMany: mockHistoryDeleteMany },
  $executeRaw: mockExecuteRaw,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/slug-redirect", {
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
  mockHistoryFindUnique.mockResolvedValue({
    currentCwid: "sch001",
    createdAt: new Date("2025-06-03T00:00:00Z"),
    current: { slug: "jane-q-doe" },
  });
  mockHistoryDeleteMany.mockResolvedValue({ count: 1 });
  mockExecuteRaw.mockResolvedValue(1);
});

describe("POST /api/edit/slug-redirect", () => {
  it("401s when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await POST(post({ oldSlug: "j-doe" }));
    expect(res.status).toBe(401);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("403s a non-superuser and writes nothing", async () => {
    mockGetEditSession.mockResolvedValue(USER);
    const res = await POST(post({ oldSlug: "j-doe" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_superuser");
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("403s a cross-site request before touching the DB", async () => {
    const req = new NextRequest("http://localhost/api/edit/slug-redirect", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ oldSlug: "j-doe" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ oldSlug: 42 }], [{ oldSlug: "   " }], [{ oldSlug: "a".repeat(256) }]])(
    "400s a bad body %j",
    async (body) => {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_slug");
      expect(mockTransaction).not.toHaveBeenCalled();
    },
  );

  it("removes the redirect and writes one slug_redirect_remove audit row", async () => {
    const res = await POST(post({ oldSlug: " J-Doe " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, oldSlug: "j-doe", removed: true });

    expect(mockHistoryFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { oldSlug: "j-doe" } }),
    );
    expect(mockHistoryDeleteMany).toHaveBeenCalledWith({ where: { oldSlug: "j-doe" } });

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const args = mockExecuteRaw.mock.calls[0];
    // Bound values: actor, target type, target id, action, fields, before, after, …
    expect(args[1]).toBe("adm001");
    expect(args[2]).toBe("scholar");
    expect(args[3]).toBe("sch001");
    expect(args[4]).toBe("slug_redirect_remove");
    expect(JSON.parse(args[6] as string)).toEqual({
      oldSlug: "j-doe",
      currentSlug: "jane-q-doe",
      recordedAt: "2025-06-03T00:00:00.000Z",
    });
    expect(args[7]).toBeNull();
  });

  it("404s a slug with no redirect and writes nothing", async () => {
    mockHistoryFindUnique.mockResolvedValue(null);
    const res = await POST(post({ oldSlug: "no-such-slug" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    expect(mockHistoryDeleteMany).not.toHaveBeenCalled();
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("404s (no audit row) when a concurrent remove got there first", async () => {
    mockHistoryDeleteMany.mockResolvedValue({ count: 0 });
    const res = await POST(post({ oldSlug: "j-doe" }));
    expect(res.status).toBe(404);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("500s when the transaction fails (e.g. the audit insert is refused)", async () => {
    mockExecuteRaw.mockRejectedValue(new Error("Data truncated for column 'action'"));
    const res = await POST(post({ oldSlug: "j-doe" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("write_failed");
  });
});
