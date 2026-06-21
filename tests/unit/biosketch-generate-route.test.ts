/**
 * POST /api/edit/biosketch/generate (#917 v5). Mirrors the overview generate-route
 * test's mocking: the facts assembly, the generator, the rate-limit, and the authz
 * predicate are unit-tested elsewhere; here they are mocked so the test exercises the
 * route's gates only (flag, personal-statement required-inputs, authz, rate-limit,
 * scholar-not-found, sparse, success, persistence, generation-failure). No network, no DB.
 * The params normalizer is NOT mocked — the required-input 400 depends on it.
 *
 * The generate path is STREAMED (`editOkStream`): the response is a 200 stream whose body is
 * produced asynchronously, so a test must `await res.json()` (drain the stream) BEFORE asserting
 * on the generate/persist mocks — `await POST(...)` alone returns before the body is produced.
 * A gateway failure is therefore an in-body `{ ok: false, error }` (status stays 200), not a 502.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockEnabled,
  mockAssembleFacts,
  mockHasSufficient,
  mockGenerateBiosketch,
  mockRecordAttempt,
  mockGenerationCreate,
  mockAuthorizeOverviewWrite,
  mockLoadDeltas,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockAssembleFacts: vi.fn(),
  mockHasSufficient: vi.fn(),
  mockGenerateBiosketch: vi.fn(),
  mockRecordAttempt: vi.fn(),
  mockGenerationCreate: vi.fn(),
  mockAuthorizeOverviewWrite: vi.fn(),
  mockLoadDeltas: vi.fn(),
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
  hasSufficientFacts: mockHasSufficient,
}));
vi.mock("@/lib/edit/overview-selection-store", () => ({
  loadOverviewSelectionDeltas: mockLoadDeltas,
}));
vi.mock("@/lib/edit/biosketch-generator", () => ({
  generateBiosketch: mockGenerateBiosketch,
  isBiosketchGenerateEnabled: mockEnabled,
}));
vi.mock("@/lib/edit/rate-limit", () => ({
  recordBiosketchGenerateAttempt: mockRecordAttempt,
}));
vi.mock("@/lib/edit/overview-authz", () => ({
  authorizeOverviewWrite: mockAuthorizeOverviewWrite,
}));
vi.mock("@/lib/db", () => ({
  db: { read: {}, write: { biosketchGeneration: { create: mockGenerationCreate } } },
}));

import { POST } from "@/app/api/edit/biosketch/generate/route";

const SELF = { cwid: "self01", isSuperuser: false, isCommsSteward: false };
const ADMIN = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/biosketch/generate", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

const FACTS = { name: "Jane Smith" };
const GEN_RESULT = {
  mode: "contributions" as const,
  entries: ["First contribution.", "Second contribution."],
  model: "us.anthropic.claude-opus-4-8",
  removed: [],
  overflow: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockEnabled.mockReturnValue(true);
  mockGetEditSession.mockResolvedValue(SELF);
  mockAssembleFacts.mockResolvedValue(FACTS);
  mockHasSufficient.mockReturnValue(true);
  mockGenerateBiosketch.mockResolvedValue(GEN_RESULT);
  mockRecordAttempt.mockResolvedValue({ allowed: true, count: 1, limit: 10 });
  mockGenerationCreate.mockResolvedValue({ id: "bgen123" });
  mockAuthorizeOverviewWrite.mockResolvedValue({ ok: true, viaUnitAdminUnit: null });
  mockLoadDeltas.mockResolvedValue(NO_DELTAS);
});

describe("POST /api/edit/biosketch/generate", () => {
  it("404 when the feature flag is off (no work done)", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(404);
    expect(mockAssembleFacts).not.toHaveBeenCalled();
    expect(mockGenerateBiosketch).not.toHaveBeenCalled();
  });

  it("400 invalid_entity_id when entityId is missing", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_entity_id", field: "entityId" });
  });

  it("400 missing_project_inputs for a personal statement without project title/aims", async () => {
    const res = await POST(post({ entityId: "self01", params: { mode: "personal_statement" } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "missing_project_inputs" });
    // Gated BEFORE authz / rate-limit / generate — no work done.
    expect(mockAuthorizeOverviewWrite).not.toHaveBeenCalled();
    expect(mockGenerateBiosketch).not.toHaveBeenCalled();
  });

  it("200 for a personal statement WITH project title + aims (passes the required-input gate)", async () => {
    mockGenerateBiosketch.mockResolvedValue({
      ...GEN_RESULT,
      mode: "personal_statement",
      entries: ["My statement."],
    });
    const res = await POST(
      post({
        entityId: "self01",
        params: { mode: "personal_statement", projectTitle: "CNS gene therapy", aims: "Aim 1." },
      }),
    );
    expect(res.status).toBe(200);
    await res.json(); // drain the stream so the generate + persist have run
    expect(mockGenerateBiosketch).toHaveBeenCalled();
    // Project title + aims persist to their dedicated columns for a personal statement.
    expect(mockGenerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mode: "personal_statement",
          projectTitle: "CNS gene therapy",
          projectAims: "Aim 1.",
        }),
      }),
    );
  });

  it("403 when the shared overview-write predicate denies", async () => {
    mockAuthorizeOverviewWrite.mockResolvedValue({ ok: false, reason: "not_self" });
    const res = await POST(post({ entityId: "other9" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
    expect(mockGenerateBiosketch).not.toHaveBeenCalled();
    expect(mockAuthorizeOverviewWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        session: SELF,
        realCwid: "self01",
        impersonatedCwid: null,
        entityId: "other9",
      }),
    );
  });

  it("200 for an authorized non-self actor (superuser); history attributes the accountable human", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(post({ entityId: "other9" }));
    expect(res.status).toBe(200);
    await res.json(); // drain the stream so the persist has run
    // `createdByCwid` is the REAL signed-in actor (realCwid), not the target; with no
    // impersonation overlay active, `impersonatedCwid` is null.
    expect(mockGenerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cwid: "other9",
          createdByCwid: "adm001",
          impersonatedCwid: null,
        }),
      }),
    );
  });

  it("429 when rate-limited; no facts assembly, no generate", async () => {
    mockRecordAttempt.mockResolvedValue({
      allowed: false,
      count: 11,
      limit: 10,
      retryAfterSeconds: 1800,
    });
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1800");
    expect(mockAssembleFacts).not.toHaveBeenCalled();
    expect(mockGenerateBiosketch).not.toHaveBeenCalled();
    // Keyed on the TARGET scholar, in the biosketch namespace.
    expect(mockRecordAttempt).toHaveBeenCalledWith("self01");
  });

  it("404 scholar_not_found when facts are null", async () => {
    mockAssembleFacts.mockResolvedValue(null);
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "scholar_not_found", field: "entityId" });
    expect(mockGenerateBiosketch).not.toHaveBeenCalled();
  });

  it("422 insufficient_facts on a sparse payload", async () => {
    mockHasSufficient.mockReturnValue(false);
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "insufficient_facts" });
    expect(mockGenerateBiosketch).not.toHaveBeenCalled();
  });

  it("500 write_failed when the rate-limit DB call throws (no generate)", async () => {
    mockRecordAttempt.mockRejectedValue(new Error("rate-limit table missing"));
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
    expect(mockGenerateBiosketch).not.toHaveBeenCalled();
  });

  it("generation_failed as an in-body error when the gateway throws (streamed 200, no DB write)", async () => {
    mockGenerateBiosketch.mockRejectedValue(new Error("gateway timeout"));
    const res = await POST(post({ entityId: "self01" }));
    // The response committed a 200 stream before generation ran, so a gateway failure is an
    // in-body { ok: false } the client branches on — not a 5xx status.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, error: "generation_failed" });
    expect(mockGenerationCreate).not.toHaveBeenCalled();
  });

  it("200 returns the entries + mode + model + overflow + removedCount + generationId", async () => {
    mockGenerateBiosketch.mockResolvedValue({
      mode: "contributions",
      entries: ["A.", "B."],
      model: "us.anthropic.claude-opus-4-8",
      removed: [{ span: "seminal", category: "superlative", reason: "" }],
      overflow: [{ index: 0, chars: 2200 }],
    });
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      mode: "contributions",
      entries: ["A.", "B."],
      model: "us.anthropic.claude-opus-4-8",
      overflow: [{ index: 0, chars: 2200 }],
      removedCount: 1,
      generationId: "bgen123",
    });
  });

  it("persists a contributions row with null project fields + the steering params blob", async () => {
    const res = await POST(
      post({ entityId: "self01", params: { mode: "contributions", maxContributions: 3 } }),
    );
    await res.json(); // drain the stream so the persist has run
    expect(mockGenerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cwid: "self01",
          mode: "contributions",
          entries: GEN_RESULT.entries,
          projectTitle: null,
          projectAims: null,
          model: "us.anthropic.claude-opus-4-8",
          // #917 v6 — the RESOLVED default version (no env override in test → v6).
          promptVersion: "v6",
          params: {
            mode: "contributions",
            maxContributions: 3,
            emphasis: "",
            instructions: "",
            promptVersion: "v6",
          },
          // Audit: the accountable human (self here), no impersonation overlay.
          createdByCwid: "self01",
          impersonatedCwid: null,
        }),
      }),
    );
  });

  it("assembles facts with an empty selection + the durable deltas", async () => {
    const res = await POST(post({ entityId: "self01" }));
    await res.json(); // drain the stream so the detached generation settles within this test
    expect(mockLoadDeltas).toHaveBeenCalledWith("self01");
    expect(mockAssembleFacts).toHaveBeenCalledWith(
      "self01",
      { pmids: [], grantIds: [], toolNames: [] },
      { deltas: NO_DELTAS },
    );
  });

  it("still 200 with generationId null when the history insert throws (entries preserved)", async () => {
    mockGenerationCreate.mockRejectedValue(new Error("biosketch_generation insert failed"));
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, entries: GEN_RESULT.entries, generationId: null });
  });
});
