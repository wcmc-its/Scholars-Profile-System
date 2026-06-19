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

const SELF = { cwid: "self01", isSuperuser: false };
const ADMIN = { cwid: "adm001", isSuperuser: true };

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
  mockGetEditSession.mockResolvedValue(SELF);
  mockAssembleFacts.mockResolvedValue(FACTS);
  mockHasSufficient.mockReturnValue(true);
  mockGenerateDraft.mockResolvedValue({ draft: "<p>Draft.</p>", model: "anthropic/claude-sonnet-4.5" });
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
  elements: [],
  instructions: "",
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
      generationId: "gen123",
    });
    // the history row is written from the actor's cwid with the normalized params
    // plus the (empty here) normalized source selection (v3.1).
    expect(mockGenerationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cwid: "self01",
          text: "<p>Draft.</p>",
          model: "anthropic/claude-sonnet-4.5",
          params: { ...NORMALIZED_EMPTY, selection: { pmids: [], grantIds: [], toolNames: [] } },
          createdByCwid: "self01",
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
      elements: ["methods"], // de-duped + unknown key filtered
      instructions: "keep it brief", // trimmed
    });
  });

  it("normalizes a garbage params value to the defaults (200, not 400)", async () => {
    const res = await POST(post({ entityId: "self01", params: "not-an-object" }));
    expect(res.status).toBe(200);
    expect(mockGenerateDraft).toHaveBeenCalledWith(FACTS, NORMALIZED_EMPTY);
  });

  it("502 generation_failed when the gateway throws (no DB write)", async () => {
    mockGenerateDraft.mockRejectedValue(new Error("gateway timeout"));
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "generation_failed" });
  });
});
