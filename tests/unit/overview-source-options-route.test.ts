/**
 * GET /api/edit/overview/source-options (#742 v3.1; target-aware since #986).
 * The Sources drawer's candidate lists for the scholar being edited (`?cwid`,
 * default self), authorized by the shared `authorizeOverviewWrite` predicate so
 * a superuser on `/edit/scholar/X` drafts from X's corpus, not their own. The
 * identity resolver, authz predicate, and the loader are mocked — no network/DB.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { mockResolveIdentity, mockAuthorize, mockLogDenial, mockEnabled, mockLoadOptions } =
  vi.hoisted(() => ({
    mockResolveIdentity: vi.fn(),
    mockAuthorize: vi.fn(),
    mockLogDenial: vi.fn(),
    mockEnabled: vi.fn(),
    mockLoadOptions: vi.fn(),
  }));

vi.mock("@/lib/edit/request", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/edit/request")>();
  return { ...actual, resolveEditIdentity: mockResolveIdentity };
});
vi.mock("@/lib/edit/overview-authz", () => ({ authorizeOverviewWrite: mockAuthorize }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogDenial }));
vi.mock("@/lib/db", () => ({ db: { read: {} } }));
vi.mock("@/lib/edit/overview-generator", () => ({ isOverviewGenerateEnabled: mockEnabled }));
vi.mock("@/lib/edit/overview-facts", () => ({ loadOverviewSourceOptions: mockLoadOptions }));

import { GET } from "@/app/api/edit/overview/source-options/route";

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
const OPTIONS = { publications: [], funding: [], tools: [] };

const req = (url = "http://localhost/api/edit/overview/source-options"): NextRequest =>
  new Request(url) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockEnabled.mockReturnValue(true);
  mockResolveIdentity.mockResolvedValue(SELF_IDENTITY);
  mockAuthorize.mockResolvedValue({ ok: true });
  mockLoadOptions.mockResolvedValue(OPTIONS);
});

describe("GET /api/edit/overview/source-options", () => {
  it("404 when the feature flag is off (no session or DB work)", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(mockResolveIdentity).not.toHaveBeenCalled();
    expect(mockLoadOptions).not.toHaveBeenCalled();
  });

  it("401 when there is no session", async () => {
    mockResolveIdentity.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockLoadOptions).not.toHaveBeenCalled();
  });

  it("defaults the target to the effective session cwid when no ?cwid is given", async () => {
    await GET(req());
    expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({ entityId: "self01" }));
    expect(mockLoadOptions).toHaveBeenCalledWith("self01");
  });

  it("loads the FOREIGN target when ?cwid is given and authz allows", async () => {
    mockResolveIdentity.mockResolvedValue(SUPERUSER_IDENTITY);
    await GET(req("http://localhost/api/edit/overview/source-options?cwid=other9"));
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "other9", realCwid: "admin1" }),
    );
    expect(mockLoadOptions).toHaveBeenCalledWith("other9");
  });

  it("403 and loads nothing when the foreign-read authz denies", async () => {
    mockAuthorize.mockResolvedValue({ ok: false, reason: "not_superuser" });
    const res = await GET(req("http://localhost/api/edit/overview/source-options?cwid=other9"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_superuser" });
    expect(mockLogDenial).toHaveBeenCalledWith(
      expect.objectContaining({ targetCwid: "other9", reason: "not_superuser" }),
    );
    expect(mockLoadOptions).not.toHaveBeenCalled();
  });

  it("200 with the candidate lists on success", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, publications: [], funding: [], tools: [] });
  });

  it("500 read_failed when the loader throws", async () => {
    mockLoadOptions.mockRejectedValue(new Error("db read failed"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "read_failed" });
  });
});
