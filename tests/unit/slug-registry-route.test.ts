/**
 * `GET /api/edit/slugs` — the slug-registry availability checker endpoint
 * (#497). Superuser-gated (live re-check), NOT flag-gated; returns the live
 * `resolveSlugStatus` verdict. Mirrors the `GET /api/edit/slug-request` test
 * shape (mocked boundary deps, real route handler).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetEditSession, mockResolve } = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockResolve: vi.fn(),
}));

// The route imports `editError`/`editOk` from `lib/edit/request`, which pulls in
// the effective-identity → superuser graph; mock both the GET-path
// `getEditSession` and the transitively-needed `isSuperuser`.
vi.mock("@/lib/auth/superuser", () => ({
  getEditSession: mockGetEditSession,
  isSuperuser: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("@/lib/api/slug-registry", () => ({ resolveSlugStatus: mockResolve }));

import { GET } from "@/app/api/edit/slugs/route";

const ADMIN = { cwid: "adm001", isSuperuser: true };
const NONADMIN = { cwid: "non001", isSuperuser: false };

function get(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/edit/slugs${qs}`, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(ADMIN);
  mockResolve.mockResolvedValue({ state: "available", slug: "free-slug" });
});

describe("GET /api/edit/slugs", () => {
  it("401 when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await GET(get("?slug=x"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("403 for a non-superuser (logs the denial)", async () => {
    mockGetEditSession.mockResolvedValue(NONADMIN);
    const res = await GET(get("?slug=x"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_superuser" });
    expect(console.warn).toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("400 when the slug param is missing", async () => {
    const res = await GET(get());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "missing_slug", field: "slug" });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("400 when the slug param is blank", async () => {
    const res = await GET(get("?slug=%20%20"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "missing_slug" });
  });

  it("is NOT flag-gated — works regardless of SELF_EDIT_SLUG_REQUEST", async () => {
    const prev = process.env.SELF_EDIT_SLUG_REQUEST;
    process.env.SELF_EDIT_SLUG_REQUEST = "off";
    try {
      const res = await GET(get("?slug=free-slug"));
      expect(res.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.SELF_EDIT_SLUG_REQUEST;
      else process.env.SELF_EDIT_SLUG_REQUEST = prev;
    }
  });

  it("returns the resolveSlugStatus verdict for a valid slug", async () => {
    mockResolve.mockResolvedValue({
      state: "taken",
      slug: "jane-smith",
      held: "live",
      cwid: "js1",
      name: "Jane Smith",
    });
    const res = await GET(get("?slug=jane-smith"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      status: { state: "taken", held: "live", cwid: "js1", name: "Jane Smith" },
    });
    expect(mockResolve).toHaveBeenCalledWith("jane-smith", expect.anything());
  });
});
