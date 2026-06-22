/**
 * POST /api/edit/overview/generate (#742). Mirrors the slug-request route's
 * mocking: the facts assembly, the generator, and the rate-limit are unit-tested
 * elsewhere; here they are mocked so the test exercises the route's gates only
 * (flag, owner-authz, rate-limit, scholar-not-found, sparse, success, 502). No
 * network, no DB.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockEnabled,
  mockStreamEnabled,
  mockResolveModel,
  mockAssembleFacts,
  mockHasSufficient,
  mockGenerateDraft,
  mockRecordAttempt,
  mockGenerationCreate,
  mockAuthorizeOverviewWrite,
  mockLoadDeltas,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockStreamEnabled: vi.fn(),
  mockResolveModel: vi.fn(),
  mockAssembleFacts: vi.fn(),
  mockHasSufficient: vi.fn(),
  mockGenerateDraft: vi.fn(),
  mockRecordAttempt: vi.fn(),
  mockGenerationCreate: vi.fn(),
  mockAuthorizeOverviewWrite: vi.fn(),
  mockLoadDeltas: vi.fn(),
}));

/** The no-delta shape the store returns when a scholar has no stored selection. */
const NO_DELTAS = {
  pinned: {},
  excluded: {},
  publicationPositions: "led" as const,
  fundingRoles: "led" as const,
};

// readEditRequest resolves identity through the #637 effective-identity seam;
// drive real == effective from the one knob (non-impersonating).
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
// #742 §2.5 — the route loads the scholar's durable selection deltas before
// assembling facts; mocked to the default (no-delta) shape so the route's gates
// are exercised in isolation (the assembler is mocked too).
vi.mock("@/lib/edit/overview-selection-store", () => ({
  loadOverviewSelectionDeltas: mockLoadDeltas,
}));
vi.mock("@/lib/edit/overview-generator", () => ({
  generateOverviewDraft: mockGenerateDraft,
  isOverviewGenerateEnabled: mockEnabled,
  isOverviewGenerateStreamEnabled: mockStreamEnabled,
  resolveEffectiveOverviewModel: mockResolveModel,
}));
vi.mock("@/lib/edit/rate-limit", () => ({
  recordOverviewGenerateAttempt: mockRecordAttempt,
}));
// #844 follow-up — the generator authorizes via the shared overview-write
// predicate (unit-tested in overview-authz.test.ts); here it is mocked so the
// route's gates are exercised in isolation.
vi.mock("@/lib/edit/overview-authz", () => ({
  authorizeOverviewWrite: mockAuthorizeOverviewWrite,
}));
// #742 Phase B — the route now best-effort records a version-history row; it also
// reads `db.read` to pass into the authz predicate (mocked above, so the value is
// irrelevant).
vi.mock("@/lib/db", () => ({
  db: { read: {}, write: { overviewGeneration: { create: mockGenerationCreate } } },
}));

import { POST } from "@/app/api/edit/overview/generate/route";

const SELF = { cwid: "self01", isSuperuser: false, isCommsSteward: false };
const ADMIN = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };
const COMMS = { cwid: "com001", isSuperuser: false, isCommsSteward: true };

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/overview/generate", {
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
  mockStreamEnabled.mockReturnValue(false);
  mockResolveModel.mockReturnValue("anthropic/claude-sonnet-4.5");
  mockGetEditSession.mockResolvedValue(SELF);
  mockAssembleFacts.mockResolvedValue(FACTS);
  mockHasSufficient.mockReturnValue(true);
  mockGenerateDraft.mockResolvedValue({
    draft: "<p>Draft.</p>",
    model: "anthropic/claude-sonnet-4.5",
    promptVersion: "v4",
  });
  mockRecordAttempt.mockResolvedValue({ allowed: true, count: 1, limit: 10 });
  mockGenerationCreate.mockResolvedValue({ id: "gen123" });
  mockAuthorizeOverviewWrite.mockResolvedValue({ ok: true, viaUnitAdminUnit: null });
  mockLoadDeltas.mockResolvedValue(NO_DELTAS);
});

// The shape normalizeOverviewParams produces for a MISSING/garbage `params`:
// enums fall back to the defaults, but a missing element array normalizes to []
// (the DEFAULT_OVERVIEW_PARAMS element set is the UI starting point, not a
// normalization fallback). #742 Phase A.
const NORMALIZED_EMPTY = {
  voice: "third",
  tone: "formal",
  length: "standard",
  audience: "informed", // the live default audience tier
  elements: [],
  instructions: "",
  promptVersion: "v4", // #742 — the live default version
};

describe("POST /api/edit/overview/generate", () => {
  it("404 when the feature flag is off (no work done)", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(404);
    expect(mockAssembleFacts).not.toHaveBeenCalled();
    expect(mockGenerateDraft).not.toHaveBeenCalled();
  });

  it("400 invalid_entity_id when entityId is missing or not a string", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_entity_id", field: "entityId" });
  });

  it("403 not_self when the shared overview-write predicate denies (unauthorized actor)", async () => {
    mockAuthorizeOverviewWrite.mockResolvedValue({ ok: false, reason: "not_self" });
    const res = await POST(post({ entityId: "other9" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
    expect(mockGenerateDraft).not.toHaveBeenCalled();
    // authorized via the shared predicate, keyed on the real cwid / non-impersonating
    expect(mockAuthorizeOverviewWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        session: SELF,
        realCwid: "self01",
        impersonatedCwid: null,
        entityId: "other9",
      }),
    );
  });

  it("403 proxy_conflict when the shared predicate rejects a conflicted proxy", async () => {
    mockAuthorizeOverviewWrite.mockResolvedValue({ ok: false, reason: "proxy_conflict" });
    const res = await POST(post({ entityId: "other9" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "proxy_conflict" });
    expect(mockGenerateDraft).not.toHaveBeenCalled();
  });

  it("200 for an authorized non-self actor (superuser / proxy / unit-admin) — #844 follow-up", async () => {
    // The generator now shares the overview-write authz: whoever may save the bio
    // may generate a draft for it. A superuser generating for another scholar
    // succeeds, and the history row attributes the acting cwid.
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(post({ entityId: "other9" }));
    expect(res.status).toBe(200);
    expect(mockGenerateDraft).toHaveBeenCalled();
    expect(mockGenerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cwid: "other9", createdByCwid: "adm001" }),
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
    expect(mockGenerateDraft).not.toHaveBeenCalled();
  });

  it("404 scholar_not_found when facts are null", async () => {
    mockAssembleFacts.mockResolvedValue(null);
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "scholar_not_found", field: "entityId" });
    expect(mockGenerateDraft).not.toHaveBeenCalled();
  });

  it("422 insufficient_facts on a sparse payload", async () => {
    mockHasSufficient.mockReturnValue(false);
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "insufficient_facts" });
    expect(mockGenerateDraft).not.toHaveBeenCalled();
  });

  it("500 write_failed when the rate-limit DB call throws (no generate)", async () => {
    mockRecordAttempt.mockRejectedValue(new Error("Table 'request_change_rate_limit' doesn't exist"));
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
    expect(mockGenerateDraft).not.toHaveBeenCalled();
  });

  it("500 write_failed when facts assembly throws (no generate)", async () => {
    mockAssembleFacts.mockRejectedValue(new Error("db read failed"));
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
    expect(mockGenerateDraft).not.toHaveBeenCalled();
  });

  it("200 with the sanitized draft + model + generationId on success", async () => {
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      draft: "<p>Draft.</p>",
      model: "anthropic/claude-sonnet-4.5",
      promptVersion: "v4",
      generationId: "gen123",
    });
    // the history row is written from the actor's cwid with the normalized params
    // plus the (empty here) normalized source selection (v3.1), and the version is
    // recorded in its dedicated column (#742).
    expect(mockGenerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cwid: "self01",
          text: "<p>Draft.</p>",
          status: "succeeded",
          error: null,
          model: "anthropic/claude-sonnet-4.5",
          promptVersion: "v4",
          params: { ...NORMALIZED_EMPTY, selection: { pmids: [], grantIds: [], toolNames: [] } },
          // audit parity: the accountable human + the (null, non-impersonating) overlay.
          createdByCwid: "self01",
          impersonatedCwid: null,
        }),
      }),
    );
  });

  it("loads the durable deltas and forwards them to the assembler on the empty-selection path", async () => {
    await POST(post({ entityId: "self01" }));
    expect(mockLoadDeltas).toHaveBeenCalledWith("self01");
    expect(mockAssembleFacts).toHaveBeenCalledWith(
      "self01",
      { pmids: [], grantIds: [], toolNames: [] },
      { deltas: NO_DELTAS },
    );
  });

  it("STILL loads + forwards the deltas when an explicit snapshot is posted (title/education deltas must bite)", async () => {
    // The pre-#742-Phase-2b route skipped the deltas load on the explicit path; titles
    // & education are not carried in the snapshot, so the load must be unconditional.
    await POST(post({ entityId: "self01", selection: { pmids: ["p1"] } }));
    expect(mockLoadDeltas).toHaveBeenCalledWith("self01");
    expect(mockAssembleFacts).toHaveBeenCalledWith(
      "self01",
      { pmids: ["p1"], grantIds: [], toolNames: [] },
      { deltas: NO_DELTAS },
    );
  });

  it("still 200 with generationId null when the history insert throws (draft preserved)", async () => {
    mockGenerationCreate.mockRejectedValue(new Error("overview_generation insert failed"));
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      draft: "<p>Draft.</p>", // the draft is never lost over a history-write hiccup
      model: "anthropic/claude-sonnet-4.5",
      generationId: null,
    });
  });

  it("passes the normalized default-enum params to the generator when params is absent", async () => {
    await POST(post({ entityId: "self01" }));
    expect(mockGenerateDraft).toHaveBeenCalledWith(FACTS, NORMALIZED_EMPTY);
  });

  it("passes through valid caller params, normalized (2nd arg)", async () => {
    await POST(
      post({
        entityId: "self01",
        params: {
          voice: "first",
          tone: "conversational",
          length: "extended",
          elements: ["methods", "methods", "not_a_theme"],
          instructions: "  keep it brief  ",
        },
      }),
    );
    expect(mockGenerateDraft).toHaveBeenCalledWith(FACTS, {
      voice: "first",
      tone: "conversational",
      length: "extended",
      audience: "informed", // no audience posted → default
      elements: ["methods"], // de-duped + unknown key filtered
      instructions: "keep it brief", // trimmed
      promptVersion: "v4", // no version posted → default
    });
  });

  it("normalizes a garbage params value to the defaults (200, not 400)", async () => {
    const res = await POST(post({ entityId: "self01", params: "not-an-object" }));
    expect(res.status).toBe(200);
    expect(mockGenerateDraft).toHaveBeenCalledWith(FACTS, NORMALIZED_EMPTY);
  });

  it("502 generation_failed when the gateway throws — and persists a FAILED run (buffered)", async () => {
    mockGenerateDraft.mockRejectedValue(new Error("gateway timeout"));
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "generation_failed" });
    // persist-every-run: the failed attempt is recorded (text null, status "failed"),
    // attributed to the real actor — a complete audit/debug trail.
    expect(mockGenerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cwid: "self01",
          text: null,
          status: "failed",
          error: "generation_failed",
          model: "anthropic/claude-sonnet-4.5",
          createdByCwid: "self01",
          impersonatedCwid: null,
        }),
      }),
    );
  });

  // #742 prompt-version gate: only a superuser / comms_steward / curator (unit-admin)
  // may pick a NON-default version; a faculty owner (self) or proxy is forced to the
  // live default, regardless of what the (untrusted) body requests.
  describe("prompt version selection gate", () => {
    it("downgrades a non-default version to the default for a faculty owner (self)", async () => {
      await POST(post({ entityId: "self01", params: { promptVersion: "v2" } }));
      expect(mockGenerateDraft).toHaveBeenCalledWith(
        FACTS,
        expect.objectContaining({ promptVersion: "v4" }),
      );
    });

    it("honors a non-default version for a superuser", async () => {
      mockGetEditSession.mockResolvedValue(ADMIN);
      await POST(post({ entityId: "other9", params: { promptVersion: "v2" } }));
      expect(mockGenerateDraft).toHaveBeenCalledWith(
        FACTS,
        expect.objectContaining({ promptVersion: "v2" }),
      );
    });

    it("honors a non-default version for a comms_steward", async () => {
      mockGetEditSession.mockResolvedValue(COMMS);
      await POST(post({ entityId: "other9", params: { promptVersion: "v2" } }));
      expect(mockGenerateDraft).toHaveBeenCalledWith(
        FACTS,
        expect.objectContaining({ promptVersion: "v2" }),
      );
    });

    it("honors a non-default version for an org-unit curator (unit-admin)", async () => {
      mockAuthorizeOverviewWrite.mockResolvedValue({
        ok: true,
        viaUnitAdminUnit: { kind: "department", code: "D1", name: "Medicine" },
      });
      await POST(post({ entityId: "other9", params: { promptVersion: "v2" } }));
      expect(mockGenerateDraft).toHaveBeenCalledWith(
        FACTS,
        expect.objectContaining({ promptVersion: "v2" }),
      );
    });

    it("persists the honored version in BOTH the column and the params blob (consistent)", async () => {
      // A superuser honors v2; the column records result.promptVersion AND the blob
      // carries the (downgraded-or-honored) effectiveParams version — both must be v2.
      mockGetEditSession.mockResolvedValue(ADMIN);
      mockGenerateDraft.mockResolvedValue({
        draft: "<p>Draft.</p>",
        model: "anthropic/claude-sonnet-4.5",
        promptVersion: "v2",
      });
      await POST(post({ entityId: "other9", params: { promptVersion: "v2" } }));
      expect(mockGenerationCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            promptVersion: "v2", // the dedicated column
            params: expect.objectContaining({ promptVersion: "v2" }), // the restore blob
          }),
        }),
      );
    });
  });

  // Streamed path (SELF_EDIT_OVERVIEW_GENERATE_STREAM on) — the response is NDJSON;
  // success is an in-body `result` line and a gateway throw is an in-body failure line
  // (status stays 200), with the run still persisted (success or failed).
  describe("streaming (SELF_EDIT_OVERVIEW_GENERATE_STREAM)", () => {
    beforeEach(() => mockStreamEnabled.mockReturnValue(true));

    async function resultLine(res: Response): Promise<Record<string, unknown> | undefined> {
      const text = await res.text();
      return text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((m) => m.type === "result");
    }

    it("streams NDJSON with a terminal result line carrying the draft + a succeeded row", async () => {
      const res = await POST(post({ entityId: "self01" }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      expect(await resultLine(res)).toMatchObject({
        ok: true,
        draft: "<p>Draft.</p>",
        generationId: "gen123",
      });
      expect(mockGenerationCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "succeeded" }) }),
      );
    });

    it("emits an in-body failure result (status 200) and persists a FAILED run on a gateway throw", async () => {
      mockGenerateDraft.mockRejectedValue(new Error("gateway timeout"));
      const res = await POST(post({ entityId: "self01" }));
      expect(res.status).toBe(200); // NDJSON: failure is in-body, not a 5xx
      expect(await resultLine(res)).toMatchObject({ ok: false, error: "generation_failed" });
      expect(mockGenerationCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "failed", text: null, error: "generation_failed" }),
        }),
      );
    });

    it("a pre-flight failure (rate limit) is still a buffered 429, not NDJSON", async () => {
      mockRecordAttempt.mockResolvedValue({
        allowed: false,
        count: 11,
        limit: 10,
        retryAfterSeconds: 1800,
      });
      const res = await POST(post({ entityId: "self01" }));
      expect(res.status).toBe(429);
      expect(res.headers.get("content-type")).toContain("application/json");
    });
  });
});
