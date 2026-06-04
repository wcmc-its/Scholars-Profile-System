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
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockAssembleFacts: vi.fn(),
  mockHasSufficient: vi.fn(),
  mockGenerateDraft: vi.fn(),
  mockRecordAttempt: vi.fn(),
}));

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
vi.mock("@/lib/edit/overview-generator", () => ({
  generateOverviewDraft: mockGenerateDraft,
  isOverviewGenerateEnabled: mockEnabled,
}));
vi.mock("@/lib/edit/rate-limit", () => ({
  recordOverviewGenerateAttempt: mockRecordAttempt,
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
  mockGenerateDraft.mockResolvedValue("<p>Draft.</p>");
  mockRecordAttempt.mockResolvedValue({ allowed: true, count: 1, limit: 10 });
});

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

  it("403 not_self when generating for another scholar (owner-only)", async () => {
    const res = await POST(post({ entityId: "other9" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
    expect(mockGenerateDraft).not.toHaveBeenCalled();
  });

  it("403 not_self even for a superuser (overview is self-only, not inherited)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_self" });
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

  it("200 with the sanitized draft on success", async () => {
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, draft: "<p>Draft.</p>" });
    expect(mockGenerateDraft).toHaveBeenCalledWith(FACTS);
  });

  it("502 generation_failed when the gateway throws (no DB write)", async () => {
    mockGenerateDraft.mockRejectedValue(new Error("gateway timeout"));
    const res = await POST(post({ entityId: "self01" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "generation_failed" });
  });
});
