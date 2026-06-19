/**
 * GET / PUT /api/edit/overview/selection (#742 §2.5 — durable three-state deltas).
 * Target-aware (`?cwid`, default self), authorized by the shared
 * `authorizeOverviewWrite` predicate. The identity resolver, authz predicate, and
 * the delta store are mocked — no network / DB.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { mockResolveIdentity, mockAuthorize, mockLogDenial, mockEnabled, mockLoad, mockSave } =
  vi.hoisted(() => ({
    mockResolveIdentity: vi.fn(),
    mockAuthorize: vi.fn(),
    mockLogDenial: vi.fn(),
    mockEnabled: vi.fn(),
    mockLoad: vi.fn(),
    mockSave: vi.fn(),
  }));

vi.mock("@/lib/edit/request", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/edit/request")>();
  return { ...actual, resolveEditIdentity: mockResolveIdentity };
});
vi.mock("@/lib/edit/overview-authz", () => ({ authorizeOverviewWrite: mockAuthorize }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogDenial }));
vi.mock("@/lib/db", () => ({ db: { read: {} } }));
vi.mock("@/lib/edit/overview-generator", () => ({ isOverviewGenerateEnabled: mockEnabled }));
vi.mock("@/lib/edit/overview-selection-store", () => ({
  loadOverviewSelectionDeltas: mockLoad,
  saveOverviewSelectionDeltas: mockSave,
}));

import { GET, PUT } from "@/app/api/edit/overview/selection/route";

const SELF_IDENTITY = {
  session: { cwid: "self01", isSuperuser: false },
  realCwid: "self01",
  impersonatedCwid: null,
};
const SUPERUSER_IDENTITY = {
  session: { cwid: "admin1", isSuperuser: true },
  realCwid: "admin1",
  impersonatedCwid: null,
};
const DEFAULT_DELTAS = {
  pinned: {},
  excluded: {},
  publicationPositions: "led",
  fundingRoles: "led",
};

const getReq = (url = "http://localhost/api/edit/overview/selection"): NextRequest =>
  new Request(url) as unknown as NextRequest;
const putReq = (body: unknown, url = "http://localhost/api/edit/overview/selection"): NextRequest =>
  new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockEnabled.mockReturnValue(true);
  mockResolveIdentity.mockResolvedValue(SELF_IDENTITY);
  mockAuthorize.mockResolvedValue({ ok: true });
  mockLoad.mockResolvedValue(DEFAULT_DELTAS);
  mockSave.mockResolvedValue(DEFAULT_DELTAS);
});

describe("GET /api/edit/overview/selection", () => {
  it("404 when the flag is off (no session/DB work)", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(getReq());
    expect(res.status).toBe(404);
    expect(mockResolveIdentity).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("401 when there is no session", async () => {
    mockResolveIdentity.mockResolvedValue(null);
    const res = await GET(getReq());
    expect(res.status).toBe(401);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("defaults the target to the session cwid and returns the saved deltas", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(mockLoad).toHaveBeenCalledWith("self01");
    expect(await res.json()).toMatchObject({ ok: true, deltas: DEFAULT_DELTAS });
  });

  it("reads the FOREIGN target when ?cwid is given and authz allows", async () => {
    mockResolveIdentity.mockResolvedValue(SUPERUSER_IDENTITY);
    await GET(getReq("http://localhost/api/edit/overview/selection?cwid=other9"));
    expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({ entityId: "other9" }));
    expect(mockLoad).toHaveBeenCalledWith("other9");
  });

  it("403 and reads nothing when the foreign authz denies", async () => {
    mockAuthorize.mockResolvedValue({ ok: false, reason: "not_superuser" });
    const res = await GET(getReq("http://localhost/api/edit/overview/selection?cwid=other9"));
    expect(res.status).toBe(403);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("500 read_failed when the store throws", async () => {
    mockLoad.mockRejectedValue(new Error("db read failed"));
    const res = await GET(getReq());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "read_failed" });
  });
});

describe("PUT /api/edit/overview/selection", () => {
  it("saves the deltas for the authorized target and echoes the normalized result", async () => {
    const res = await PUT(putReq({ deltas: { excluded: { publication: ["1"] } } }));
    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledWith("self01", "self01", { excluded: { publication: ["1"] } });
    expect(await res.json()).toMatchObject({ ok: true, deltas: DEFAULT_DELTAS });
  });

  it("403 and saves nothing when authz denies", async () => {
    mockAuthorize.mockResolvedValue({ ok: false, reason: "not_owner" });
    const res = await PUT(putReq({ deltas: {} }, "http://localhost/api/edit/overview/selection?cwid=other9"));
    expect(res.status).toBe(403);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("tolerates a malformed body (store normalizes)", async () => {
    const res = await PUT(
      new Request("http://localhost/api/edit/overview/selection", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "not json",
      }) as unknown as NextRequest,
    );
    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledWith("self01", "self01", undefined);
  });

  it("500 write_failed when the store throws", async () => {
    mockSave.mockRejectedValue(new Error("db write failed"));
    const res = await PUT(putReq({ deltas: {} }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});
