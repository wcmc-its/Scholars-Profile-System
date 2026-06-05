/**
 * GET /api/edit/overview/generations (#742 Phase B). Self-only history + provenance
 * read. The session source and the two provenance readers are mocked so the test
 * exercises the route's gates (flag, 401, success shape, ISO date serialization)
 * only. No network, no DB.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockEnabled,
  mockListGenerations,
  mockLoadProvenance,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockListGenerations: vi.fn(),
  mockLoadProvenance: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEditSession,
}));
vi.mock("@/lib/edit/overview-generator", () => ({
  isOverviewGenerateEnabled: mockEnabled,
}));
vi.mock("@/lib/edit/overview-provenance", () => ({
  listOverviewGenerations: mockListGenerations,
  loadOverviewProvenance: mockLoadProvenance,
}));

import { GET } from "@/app/api/edit/overview/generations/route";

const SELF = { cwid: "self01", isSuperuser: false };

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
  mockGetEditSession.mockResolvedValue(SELF);
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
    const res = await GET();
    expect(res.status).toBe(404);
    expect(mockGetEditSession).not.toHaveBeenCalled();
    expect(mockListGenerations).not.toHaveBeenCalled();
  });

  it("401 when there is no session (owner-only, self-derived cwid)", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockListGenerations).not.toHaveBeenCalled();
  });

  it("reads the SESSION user's own cwid (never a request param)", async () => {
    await GET();
    expect(mockListGenerations).toHaveBeenCalledWith("self01");
    expect(mockLoadProvenance).toHaveBeenCalledWith("self01");
  });

  it("200 with generations + provenance, dates serialized to ISO strings", async () => {
    const res = await GET();
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
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, provenance: null });
  });

  it("500 read_failed when a reader throws", async () => {
    mockListGenerations.mockRejectedValue(new Error("db read failed"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "read_failed" });
  });
});
