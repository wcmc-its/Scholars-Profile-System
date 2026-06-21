/**
 * POST /api/edit/biosketch/generate (#917 v5). Mirrors the overview generate-route
 * test's mocking: the facts assembly, the generator, the rate-limit, and the authz
 * predicate are unit-tested elsewhere; here they are mocked so the test exercises the
 * route's gates only (flag, personal-statement required-inputs, authz, rate-limit,
 * scholar-not-found, sparse, success, persistence, generation-failure). No network, no DB.
 * The params normalizer is NOT mocked — the required-input 400 depends on it.
 *
 * The generate path is STREAMED as NDJSON (`editOkStream`, #917 follow-up A): the body is zero or
 * more `{"type":"progress",...}` lines then a final `{"type":"result",...}` line, produced
 * asynchronously — so a test drains it with `drainStream(res)` (which parses + returns the result
 * line) BEFORE asserting on the generate/persist mocks. A gateway failure is an in-body
 * `{ ok: false, error }` result line (status stays 200), not a 502. A pre-stream rejection
 * (4xx/5xx) is still a BUFFERED `editError`, read with `res.json()`.
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

/** Drain the NDJSON stream: read the whole body, parse every line, and return the terminal
 *  `{"type":"result",...}` line (or null). Also exposes the progress lines for the wiring test. */
async function drainStream(res: Response): Promise<{
  result: Record<string, unknown> | null;
  progress: Record<string, unknown>[];
  /** Every parsed line in stream order — for asserting the progress-then-result invariant. */
  all: Record<string, unknown>[];
}> {
  const text = await res.text();
  const msgs = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    result: msgs.filter((m) => m.type === "result").at(-1) ?? null,
    progress: msgs.filter((m) => m.type === "progress"),
    all: msgs,
  };
}

/** Convenience: the result line only (the common case). */
async function drainResult(res: Response): Promise<Record<string, unknown> | null> {
  return (await drainStream(res)).result;
}

const FACTS = { name: "Jane Smith" };
const GEN_RESULT = {
  mode: "contributions" as const,
  // #917 v7 — entries are { title, body }; v6/v7 contributions carry a (possibly empty) title.
  entries: [
    { title: "", body: "First contribution." },
    { title: "", body: "Second contribution." },
  ],
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
      entries: [{ title: "", body: "My statement." }],
    });
    const res = await POST(
      post({
        entityId: "self01",
        params: { mode: "personal_statement", projectTitle: "CNS gene therapy", aims: "Aim 1." },
      }),
    );
    expect(res.status).toBe(200);
    await drainResult(res); // drain the stream so the generate + persist have run
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
    await drainResult(res); // drain the stream so the persist has run
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
    expect(await drainResult(res)).toMatchObject({ ok: false, error: "generation_failed" });
    expect(mockGenerationCreate).not.toHaveBeenCalled();
  });

  it("200 returns the entries + mode + model + overflow + removedCount + generationId", async () => {
    mockGenerateBiosketch.mockResolvedValue({
      mode: "contributions",
      entries: [
        { title: "First subject", body: "A." },
        { title: "Second subject", body: "B." },
      ],
      model: "us.anthropic.claude-opus-4-8",
      removed: [{ span: "seminal", category: "superlative", reason: "" }],
      overflow: [{ index: 0, chars: 2200 }],
    });
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(200);
    expect(await drainResult(res)).toMatchObject({
      ok: true,
      mode: "contributions",
      entries: [
        { title: "First subject", body: "A." },
        { title: "Second subject", body: "B." },
      ],
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
    await drainResult(res); // drain the stream so the persist has run
    expect(mockGenerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cwid: "self01",
          mode: "contributions",
          entries: GEN_RESULT.entries,
          projectTitle: null,
          projectAims: null,
          model: "us.anthropic.claude-opus-4-8",
          // #917 v7 — the RESOLVED default version (no env override in test → v7).
          promptVersion: "v7",
          params: {
            mode: "contributions",
            maxContributions: 3,
            emphasis: "",
            instructions: "",
            promptVersion: "v7",
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
    await drainResult(res); // drain the stream so the detached generation settles within this test
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
    expect(await drainResult(res)).toMatchObject({
      ok: true,
      entries: GEN_RESULT.entries,
      generationId: null,
    });
  });

  it("streams the generator's progress events as NDJSON lines before the result (#917 A)", async () => {
    mockGenerateBiosketch.mockImplementation(
      async (
        _facts: unknown,
        _params: unknown,
        opts: { onProgress?: (e: unknown) => void } | undefined,
      ) => {
        opts?.onProgress?.({ phase: "drafting" });
        opts?.onProgress?.({ phase: "faithfulness", done: 1, total: 2 });
        opts?.onProgress?.({ phase: "done" });
        return GEN_RESULT;
      },
    );
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const { result, progress, all } = await drainStream(res);
    expect(progress).toEqual([
      { type: "progress", phase: "drafting" },
      { type: "progress", phase: "faithfulness", done: 1, total: 2 },
      { type: "progress", phase: "done" },
    ]);
    expect(result).toMatchObject({ type: "result", ok: true, entries: GEN_RESULT.entries });
    // The protocol invariant: zero or more progress lines THEN exactly one terminal result line.
    expect(all.at(-1)).toMatchObject({ type: "result" });
    expect(all.filter((m) => m.type === "result")).toHaveLength(1);
  });
});
