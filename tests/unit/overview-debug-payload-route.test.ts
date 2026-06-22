/**
 * POST /api/edit/overview/debug-payload (overview parity with the biosketch debug route).
 * Mirrors the biosketch debug-payload test's mocking: facts assembly, the authz predicate, and
 * the (pure) prompt builders are mocked so the test exercises the route's GATES + wiring only —
 * flag, entityId shape, authz, the hard superuser gate, scholar-not-found, the assembled-payload
 * success shape (incl. the AUDIENCE tier), and that it NEVER writes the DB. The params normalizer
 * is NOT mocked, so the resolved promptVersion / audience reflect real normalization.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockEnabled,
  mockAssembleFacts,
  mockAuthorizeOverviewWrite,
  mockLoadDeltas,
  mockSystemPromptFor,
  mockBuildUserPrompt,
  mockResolveModel,
  mockToModelFacts,
  mockGenerationCreate,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockAssembleFacts: vi.fn(),
  mockAuthorizeOverviewWrite: vi.fn(),
  mockLoadDeltas: vi.fn(),
  mockSystemPromptFor: vi.fn(),
  mockBuildUserPrompt: vi.fn(),
  mockResolveModel: vi.fn(),
  mockToModelFacts: vi.fn(),
  mockGenerationCreate: vi.fn(),
}));

const NO_DELTAS = {
  pinned: {},
  excluded: {},
  publicationPositions: "led" as const,
  fundingRoles: "led" as const,
};

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
vi.mock("@/lib/edit/overview-facts", () => ({
  assembleOverviewFacts: mockAssembleFacts,
}));
vi.mock("@/lib/edit/overview-selection-store", () => ({
  loadOverviewSelectionDeltas: mockLoadDeltas,
}));
vi.mock("@/lib/edit/overview-generator", () => ({
  isOverviewGenerateEnabled: mockEnabled,
  overviewSystemPromptFor: mockSystemPromptFor,
  buildOverviewUserPrompt: mockBuildUserPrompt,
  resolveEffectiveOverviewModel: mockResolveModel,
  toModelFacts: mockToModelFacts,
}));
vi.mock("@/lib/edit/overview-authz", () => ({
  authorizeOverviewWrite: mockAuthorizeOverviewWrite,
}));
// `db.write` carries a spy so the success test can POSITIVELY assert this read-only endpoint
// never writes the history table.
vi.mock("@/lib/db", () => ({
  db: { read: {}, write: { overviewGeneration: { create: mockGenerationCreate } } },
}));

import { POST } from "@/app/api/edit/overview/debug-payload/route";

const SELF = { cwid: "self01", isSuperuser: false, isCommsSteward: false };
const ADMIN = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/overview/debug-payload", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

const FACTS = { name: "Jane Smith" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockEnabled.mockReturnValue(true);
  mockGetEditSession.mockResolvedValue(ADMIN);
  mockAssembleFacts.mockResolvedValue(FACTS);
  mockLoadDeltas.mockResolvedValue(NO_DELTAS);
  mockAuthorizeOverviewWrite.mockResolvedValue({ ok: true, viaUnitAdminUnit: null });
  mockSystemPromptFor.mockReturnValue("SYSTEM-PROMPT");
  mockBuildUserPrompt.mockReturnValue("USER-PROMPT");
  mockResolveModel.mockReturnValue("us.anthropic.claude-opus-4-8");
  mockToModelFacts.mockReturnValue({ projection: "public" });
});

describe("POST /api/edit/overview/debug-payload", () => {
  it("404 when the feature flag is off (no work done)", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await POST(post({ entityId: "other9" }));
    expect(res.status).toBe(404);
    expect(mockAssembleFacts).not.toHaveBeenCalled();
  });

  it("401 when there is no session (before any authz / superuser check)", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await POST(post({ entityId: "other9" }));
    expect(res.status).toBe(401);
    expect(mockAuthorizeOverviewWrite).not.toHaveBeenCalled();
    expect(mockAssembleFacts).not.toHaveBeenCalled();
  });

  it("400 invalid_entity_id when entityId is missing", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_entity_id", field: "entityId" });
  });

  it("403 when the shared overview-write predicate denies", async () => {
    mockAuthorizeOverviewWrite.mockResolvedValue({ ok: false, reason: "not_self" });
    const res = await POST(post({ entityId: "other9" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
    expect(mockAssembleFacts).not.toHaveBeenCalled();
  });

  it("403 forbidden when authorized but NOT a superuser (the narrower debug gate)", async () => {
    // A self owner passes authorizeOverviewWrite for themselves, but the debug payload is
    // superuser-only — so an authorized non-superuser is refused, and no facts are read.
    mockGetEditSession.mockResolvedValue(SELF);
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect(mockAssembleFacts).not.toHaveBeenCalled();
    expect(mockBuildUserPrompt).not.toHaveBeenCalled();
  });

  it("404 scholar_not_found when facts are null", async () => {
    mockAssembleFacts.mockResolvedValue(null);
    const res = await POST(post({ entityId: "other9" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "scholar_not_found", field: "entityId" });
    expect(mockBuildUserPrompt).not.toHaveBeenCalled();
  });

  it("500 read_failed when facts assembly throws (no prompt assembled)", async () => {
    mockAssembleFacts.mockRejectedValue(new Error("overview_facts read failed"));
    const res = await POST(post({ entityId: "other9" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "read_failed" });
    expect(mockBuildUserPrompt).not.toHaveBeenCalled();
  });

  it("200 assembles the exact prompt + FACTS payload (incl. audience) for a superuser, no DB write", async () => {
    const res = await POST(
      post({ entityId: "other9", params: { promptVersion: "v2", audience: "accessible" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      ok: true,
      target: "other9",
      model: "us.anthropic.claude-opus-4-8",
      promptVersion: "v2", // honored for a superuser (real normalizer keeps a valid id)
      audience: "accessible", // the selected tier echoed back
      systemPrompt: "SYSTEM-PROMPT",
      userPrompt: "USER-PROMPT",
      facts: { projection: "public" },
    });
    expect(mockToModelFacts).toHaveBeenCalledWith(FACTS);
    // Read-only: never persists a history row.
    expect(mockGenerationCreate).not.toHaveBeenCalled();
  });

  it("defaults the audience to `informed` when none is posted", async () => {
    const res = await POST(post({ entityId: "other9" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ audience: "informed" });
  });

  it("assembles facts with an empty selection + the durable deltas (same read as generate)", async () => {
    await POST(post({ entityId: "other9" }));
    expect(mockLoadDeltas).toHaveBeenCalledWith("other9");
    expect(mockAssembleFacts).toHaveBeenCalledWith(
      "other9",
      { pmids: [], grantIds: [], toolNames: [] },
      { deltas: NO_DELTAS },
    );
  });
});
