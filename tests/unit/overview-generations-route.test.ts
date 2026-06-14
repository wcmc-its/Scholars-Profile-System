/**
 * GET /api/edit/overview/generations (#742 Phase B; target-aware since #986).
 * History + provenance read for the scholar being edited (`?cwid`, default self),
 * authorized by the shared `authorizeOverviewWrite` predicate. The identity
 * resolver, the authz predicate, and the two provenance readers are mocked so the
 * test exercises the route's gates (flag, 401, foreign-read authz, success shape,
 * ISO serialization) only. No network, no DB.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const {
  mockResolveIdentity,
  mockAuthorize,
  mockLogDenial,
  mockEnabled,
  mockListGenerations,
  mockLoadProvenance,
} = vi.hoisted(() => ({
  mockResolveIdentity: vi.fn(),
  mockAuthorize: vi.fn(),
  mockLogDenial: vi.fn(),
  mockEnabled: vi.fn(),
  mockListGenerations: vi.fn(),
  mockLoadProvenance: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/edit/request")>();
  return { ...actual, resolveEditIdentity: mockResolveIdentity };
});
vi.mock("@/lib/edit/overview-authz", () => ({ authorizeOverviewWrite: mockAuthorize }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogDenial }));
vi.mock("@/lib/db", () => ({ db: { read: {} } }));
vi.mock("@/lib/edit/overview-generator", () => ({ isOverviewGenerateEnabled: mockEnabled }));
vi.mock("@/lib/edit/overview-provenance", () => ({
  listOverviewGenerations: mockListGenerations,
  loadOverviewProvenance: mockLoadProvenance,
}));

import { GET } from "@/app/api/edit/overview/generations/route";

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

const req = (url = "http://localhost/api/edit/overview/generations"): NextRequest =>
  new Request(url) as unknown as NextRequest;

const CREATED_AT = new Date("2026-06-01T00:00:00.000Z");
const UPDATED_AT = new Date("2026-06-02T12:00:00.000Z");
const PARAMS = {
  voice: "third",
  tone: "formal",
  length: "standard",
  elements: ["research_focus"],
  instructions: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockEnabled.mockReturnValue(true);
  mockResolveIdentity.mockResolvedValue(SELF_IDENTITY);
  mockAuthorize.mockResolvedValue({ ok: true });
  mockListGenerations.mockResolvedValue([
    {
      id: "gen1",
      model: "anthropic/claude-sonnet-4.5",
      params: PARAMS,
      createdAt: CREATED_AT,
      text: "<p>Draft one.</p>",
    },
  ]);
  mockLoadProvenance.mockResolvedValue({
    origin: "generated",
    model: "anthropic/claude-sonnet-4.5",
    sourceGenerationId: "gen1",
    updatedAt: UPDATED_AT,
  });
});

describe("GET /api/edit/overview/generations", () => {
  it("404 when the feature flag is off (no session or DB work)", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(mockResolveIdentity).not.toHaveBeenCalled();
    expect(mockListGenerations).not.toHaveBeenCalled();
  });

  it("401 when there is no session", async () => {
    mockResolveIdentity.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockListGenerations).not.toHaveBeenCalled();
  });

  it("defaults the target to the effective session cwid when no ?cwid is given", async () => {
    await GET(req());
    expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({ entityId: "self01" }));
    expect(mockListGenerations).toHaveBeenCalledWith("self01");
    expect(mockLoadProvenance).toHaveBeenCalledWith("self01");
  });

  it("reads the FOREIGN target when ?cwid is given and authz allows (superuser on another scholar)", async () => {
    mockResolveIdentity.mockResolvedValue(SUPERUSER_IDENTITY);
    await GET(req("http://localhost/api/edit/overview/generations?cwid=other9"));
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "other9", realCwid: "admin1" }),
    );
    expect(mockListGenerations).toHaveBeenCalledWith("other9");
    expect(mockLoadProvenance).toHaveBeenCalledWith("other9");
  });

  it("403 and reads nothing when the foreign-read authz denies", async () => {
    mockAuthorize.mockResolvedValue({ ok: false, reason: "not_superuser" });
    const res = await GET(req("http://localhost/api/edit/overview/generations?cwid=other9"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_superuser" });
    expect(mockLogDenial).toHaveBeenCalledWith(
      expect.objectContaining({ targetCwid: "other9", reason: "not_superuser" }),
    );
    expect(mockListGenerations).not.toHaveBeenCalled();
  });

  it("200 with generations + provenance, dates serialized to ISO strings", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      generations: [
        {
          id: "gen1",
          model: "anthropic/claude-sonnet-4.5",
          params: PARAMS,
          createdAt: CREATED_AT.toISOString(),
          text: "<p>Draft one.</p>",
        },
      ],
      provenance: {
        origin: "generated",
        model: "anthropic/claude-sonnet-4.5",
        sourceGenerationId: "gen1",
        updatedAt: UPDATED_AT.toISOString(),
      },
    });
  });

  it("200 with provenance null when none recorded", async () => {
    mockLoadProvenance.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, provenance: null });
  });

  it("500 read_failed when a reader throws", async () => {
    mockListGenerations.mockRejectedValue(new Error("db read failed"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "read_failed" });
  });
});
