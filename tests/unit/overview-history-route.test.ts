/**
 * /api/edit/overview/history — rename a draft (PATCH), hide a draft or saved
 * version (DELETE). Every write is scoped to the authorized target cwid; the
 * live (newest) saved version can never be hidden.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const {
  mockResolveIdentity,
  mockAuthorize,
  mockLogDenial,
  mockOrigin,
  mockEnabled,
  mockReadonly,
  mockGenUpdateMany,
  mockVersionFindFirst,
  mockVersionUpdateMany,
} = vi.hoisted(() => ({
  mockResolveIdentity: vi.fn(),
  mockAuthorize: vi.fn(),
  mockLogDenial: vi.fn(),
  mockOrigin: vi.fn(),
  mockEnabled: vi.fn(),
  mockReadonly: vi.fn(),
  mockGenUpdateMany: vi.fn(),
  mockVersionFindFirst: vi.fn(),
  mockVersionUpdateMany: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/edit/request")>();
  return {
    ...actual,
    resolveEditIdentity: mockResolveIdentity,
    impersonationReadonly: mockReadonly,
  };
});
vi.mock("@/lib/edit/overview-authz", () => ({ authorizeOverviewWrite: mockAuthorize }));
vi.mock("@/lib/edit/authz", () => ({
  logEditDenial: mockLogDenial,
  verifyRequestOrigin: mockOrigin,
}));
vi.mock("@/lib/edit/overview-generator", () => ({ isOverviewGenerateEnabled: mockEnabled }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {},
    write: {
      overviewGeneration: { updateMany: mockGenUpdateMany },
      overviewVersion: { findFirst: mockVersionFindFirst, updateMany: mockVersionUpdateMany },
    },
  },
}));

import { DELETE, PATCH } from "@/app/api/edit/overview/history/route";

const SELF = {
  session: { cwid: "self01", isSuperuser: false },
  realCwid: "self01",
  impersonatedCwid: null,
};

function req(method: string, body: unknown, url = "http://localhost/api/edit/overview/history") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockOrigin.mockReturnValue({ ok: true });
  mockEnabled.mockReturnValue(true);
  mockReadonly.mockReturnValue(true);
  mockResolveIdentity.mockResolvedValue(SELF);
  mockAuthorize.mockResolvedValue({ ok: true });
  mockGenUpdateMany.mockResolvedValue({ count: 1 });
  mockVersionUpdateMany.mockResolvedValue({ count: 1 });
  mockVersionFindFirst.mockResolvedValue({ id: "v-live" });
});

describe("PATCH (rename a draft)", () => {
  it("trims + clamps the name and scopes the write to the target's visible draft", async () => {
    const res = await PATCH(req("PATCH", { kind: "draft", id: "g1", name: `  ${"x".repeat(60)} ` }));
    expect(res.status).toBe(200);
    expect(mockGenUpdateMany).toHaveBeenCalledWith({
      where: { id: "g1", cwid: "self01", hiddenAt: null },
      data: { name: "x".repeat(40) },
    });
  });

  it("an empty name clears back to the default label", async () => {
    await PATCH(req("PATCH", { kind: "draft", id: "g1", name: "   " }));
    expect(mockGenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: null } }),
    );
  });

  it("404 when the id is not the target scholar's draft", async () => {
    mockGenUpdateMany.mockResolvedValue({ count: 0 });
    const res = await PATCH(req("PATCH", { kind: "draft", id: "other", name: "n" }));
    expect(res.status).toBe(404);
  });

  it("400 on a malformed body; versions cannot be renamed", async () => {
    expect((await PATCH(req("PATCH", { kind: "version", id: "v1", name: "n" }))).status).toBe(400);
    expect((await PATCH(req("PATCH", { kind: "draft", id: 3, name: "n" }))).status).toBe(400);
    expect(mockGenUpdateMany).not.toHaveBeenCalled();
  });
});

describe("DELETE (hide)", () => {
  it("soft-deletes a draft (hidden_at), never a hard delete", async () => {
    const res = await DELETE(req("DELETE", { kind: "draft", id: "g1" }));
    expect(res.status).toBe(200);
    expect(mockGenUpdateMany).toHaveBeenCalledWith({
      where: { id: "g1", cwid: "self01", hiddenAt: null },
      data: { hiddenAt: expect.any(Date) },
    });
  });

  it("hides an older saved version", async () => {
    const res = await DELETE(req("DELETE", { kind: "version", id: "v-old" }));
    expect(res.status).toBe(200);
    expect(mockVersionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "v-old", cwid: "self01", hiddenAt: null } }),
    );
  });

  it("409 live_version and no write when asked to hide the published version", async () => {
    const res = await DELETE(req("DELETE", { kind: "version", id: "v-live" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "live_version" });
    expect(mockVersionUpdateMany).not.toHaveBeenCalled();
  });
});

describe("guards", () => {
  it("403 and no write when authz denies the foreign target", async () => {
    mockAuthorize.mockResolvedValue({ ok: false, reason: "not_superuser" });
    const res = await DELETE(
      req("DELETE", { kind: "draft", id: "g1" }, "http://localhost/api/edit/overview/history?cwid=other9"),
    );
    expect(res.status).toBe(403);
    expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({ entityId: "other9" }));
    expect(mockGenUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request before any lookup", async () => {
    mockOrigin.mockReturnValue({ ok: false, reason: "bad_origin" });
    const res = await PATCH(req("PATCH", { kind: "draft", id: "g1", name: "n" }));
    expect(res.status).toBe(403);
    expect(mockResolveIdentity).not.toHaveBeenCalled();
  });

  it("404 when the flag is off", async () => {
    mockEnabled.mockReturnValue(false);
    expect((await DELETE(req("DELETE", { kind: "draft", id: "g1" }))).status).toBe(404);
  });

  it("refuses writes while impersonating in read-only mode", async () => {
    mockResolveIdentity.mockResolvedValue({ ...SELF, impersonatedCwid: "self01", realCwid: "admin1" });
    const res = await DELETE(req("DELETE", { kind: "draft", id: "g1" }));
    expect(res.status).toBe(403);
    expect(mockGenUpdateMany).not.toHaveBeenCalled();
  });
});
