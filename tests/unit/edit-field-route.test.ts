import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetEditSession,
  mockTransaction,
  mockFieldOverrideFindUnique,
  mockFieldOverrideUpsert,
  mockExecuteRaw,
  mockScholarFindFirst,
  mockFieldOverrideFindFirst,
  mockSlugHistoryFindFirst,
  mockReflectOverviewEdit,
  mockResolveProfiles,
  mockTxScholarFindUnique,
  mockTxScholarUpdate,
  mockTxSlugHistoryUpsert,
  mockTxGenerationFindUnique,
  mockTxProvenanceUpsert,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockTransaction: vi.fn(),
  mockFieldOverrideFindUnique: vi.fn(),
  mockFieldOverrideUpsert: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockScholarFindFirst: vi.fn(),
  mockFieldOverrideFindFirst: vi.fn(),
  mockSlugHistoryFindFirst: vi.fn(),
  mockReflectOverviewEdit: vi.fn(),
  mockResolveProfiles: vi.fn(),
  mockTxScholarFindUnique: vi.fn(),
  mockTxScholarUpdate: vi.fn(),
  mockTxSlugHistoryUpsert: vi.fn(),
  mockTxGenerationFindUnique: vi.fn(),
  mockTxProvenanceUpsert: vi.fn(),
}));

// `readEditRequest` resolves identity through the #637 effective-identity seam.
// Drive it from the same `mockGetEditSession` knob (non-impersonating: real ==
// effective, so `actor_cwid` is this cwid and `impersonatedCwid` stays null).
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
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findFirst: mockScholarFindFirst },
      fieldOverride: { findFirst: mockFieldOverrideFindFirst },
      slugHistory: { findFirst: mockSlugHistoryFindFirst },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectOverviewEdit: mockReflectOverviewEdit,
  resolveAffectedProfiles: mockResolveProfiles,
}));

import { POST } from "@/app/api/edit/field/route";

const SELF = { cwid: "self01", isSuperuser: false };
const ADMIN = { cwid: "adm001", isSuperuser: true };

const fakeTx = {
  fieldOverride: { findUnique: mockFieldOverrideFindUnique, upsert: mockFieldOverrideUpsert },
  scholar: { findUnique: mockTxScholarFindUnique, update: mockTxScholarUpdate },
  slugHistory: { upsert: mockTxSlugHistoryUpsert },
  // #742 Phase B — provenance is upserted in the same tx on an overview save.
  overviewGeneration: { findUnique: mockTxGenerationFindUnique },
  overviewProvenance: { upsert: mockTxProvenanceUpsert },
  $executeRaw: mockExecuteRaw,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/field", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(SELF);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockFieldOverrideFindUnique.mockResolvedValue(null);
  mockFieldOverrideUpsert.mockResolvedValue({});
  mockExecuteRaw.mockResolvedValue(1);
  mockScholarFindFirst.mockResolvedValue(null);
  mockFieldOverrideFindFirst.mockResolvedValue(null);
  mockSlugHistoryFindFirst.mockResolvedValue(null);
  mockResolveProfiles.mockResolvedValue([{ slug: "self01-slug", cwid: "self01" }]);
  // reconcileScholarSlug surface inside the tx — default: current slug differs
  // from the new value so a reconcile fires.
  mockTxScholarFindUnique.mockResolvedValue({ slug: "old-slug" });
  mockTxScholarUpdate.mockResolvedValue({});
  mockTxSlugHistoryUpsert.mockResolvedValue({});
  // #742 Phase B — no source generation by default; provenance upsert resolves.
  mockTxGenerationFindUnique.mockResolvedValue(null);
  mockTxProvenanceUpsert.mockResolvedValue({});
});

describe("POST /api/edit/field", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetEditSession.mockResolvedValue(null);
    const res = await POST(post({ entityType: "scholar", entityId: "self01", fieldName: "overview", value: "<p>x</p>" }));
    expect(res.status).toBe(401);
  });

  it("rejects a cross-scholar overview edit with 403 and writes nothing", async () => {
    const res = await POST(post({ entityType: "scholar", entityId: "other9", fieldName: "overview", value: "<p>x</p>" }));
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects an unknown fieldName with 400", async () => {
    const res = await POST(post({ entityType: "scholar", entityId: "self01", fieldName: "email", value: "x" }));
    expect(res.status).toBe(400);
  });

  it("rejects a slug edit by a non-superuser with 403", async () => {
    const res = await POST(post({ entityType: "scholar", entityId: "self01", fieldName: "slug", value: "new-slug" }));
    expect(res.status).toBe(403);
  });

  it("rejects an oversized overview with 400", async () => {
    const res = await POST(
      post({ entityType: "scholar", entityId: "self01", fieldName: "overview", value: `<p>${"a".repeat(25_000)}</p>` }),
    );
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("sanitizes a valid overview, writes one transaction + audit row, returns the sanitized value", async () => {
    const res = await POST(
      post({ entityType: "scholar", entityId: "self01", fieldName: "overview", value: "<p>Hi<script>evil()</script></p>" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fieldName).toBe("overview");
    expect(body.value).not.toContain("script");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockFieldOverrideUpsert).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // the B03 audit row
    expect(mockReflectOverviewEdit).toHaveBeenCalled();
  });

  it("returns 500 when the write transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await POST(post({ entityType: "scholar", entityId: "self01", fieldName: "overview", value: "<p>x</p>" }));
    expect(res.status).toBe(500);
  });

  it("allows a superuser slug edit when the slug is free", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "slug", value: "new-slug" }));
    expect(res.status).toBe(200);
    expect(mockReflectOverviewEdit).not.toHaveBeenCalled(); // overview reflection only
  });

  it("reconciles Scholar.slug + slug_history on a slug override (#497 §5.1)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockTxScholarFindUnique.mockResolvedValue({ slug: "brandon-swed-2" });
    const res = await POST(
      post({ entityType: "scholar", entityId: "sch5", fieldName: "slug", value: "brandon-swed" }),
    );
    expect(res.status).toBe(200);
    // the override row (the pin) is still upserted
    expect(mockFieldOverrideUpsert).toHaveBeenCalledTimes(1);
    // ...and Scholar.slug reconciled in the same tx, old slug -> history
    expect(mockTxSlugHistoryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { oldSlug: "brandon-swed-2" },
        create: { oldSlug: "brandon-swed-2", currentCwid: "sch5" },
      }),
    );
    expect(mockTxScholarUpdate).toHaveBeenCalledWith({
      where: { cwid: "sch5" },
      data: { slug: "brandon-swed" },
    });
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // B03 audit row in the same tx
  });

  it("does not touch Scholar.slug when the override equals the current slug (no-op reconcile)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockTxScholarFindUnique.mockResolvedValue({ slug: "brandon-swed" });
    const res = await POST(
      post({ entityType: "scholar", entityId: "sch5", fieldName: "slug", value: "brandon-swed" }),
    );
    expect(res.status).toBe(200);
    expect(mockFieldOverrideUpsert).toHaveBeenCalledTimes(1);
    expect(mockTxSlugHistoryUpsert).not.toHaveBeenCalled();
    expect(mockTxScholarUpdate).not.toHaveBeenCalled();
  });

  it("does NOT reconcile Scholar.slug on an overview edit (only slug overrides reconcile)", async () => {
    const res = await POST(
      post({ entityType: "scholar", entityId: "self01", fieldName: "overview", value: "<p>hi</p>" }),
    );
    expect(res.status).toBe(200);
    expect(mockTxScholarUpdate).not.toHaveBeenCalled();
    expect(mockTxSlugHistoryUpsert).not.toHaveBeenCalled();
  });

  it("rejects a colliding slug with 400 (live Scholar.slug)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockScholarFindFirst.mockResolvedValue({ cwid: "other" });
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "slug", value: "taken" }));
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects a reserved-word slug with 400 (#497 §6.1)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(post({ entityType: "scholar", entityId: "sch5", fieldName: "slug", value: "search" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("reserved");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  // ─── #742 Phase B — overview provenance, upserted in the save tx ───

  it("overview save WITH a matching sourceGenerationId saved verbatim -> origin 'generated'", async () => {
    mockTxGenerationFindUnique.mockResolvedValue({
      cwid: "self01",
      text: "<p>Verbatim draft.</p>",
      model: "anthropic/claude-sonnet-4.5",
    });
    const res = await POST(
      post({
        entityType: "scholar",
        entityId: "self01",
        fieldName: "overview",
        value: "<p>Verbatim draft.</p>",
        sourceGenerationId: "gen1",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxGenerationFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "gen1" } }),
    );
    expect(mockTxProvenanceUpsert).toHaveBeenCalledTimes(1);
    expect(mockTxProvenanceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cwid: "self01" },
        create: expect.objectContaining({
          cwid: "self01",
          origin: "generated",
          model: "anthropic/claude-sonnet-4.5",
          sourceGenerationId: "gen1",
          updatedByCwid: "self01",
        }),
        update: expect.objectContaining({
          origin: "generated",
          model: "anthropic/claude-sonnet-4.5",
          sourceGenerationId: "gen1",
        }),
      }),
    );
  });

  it("overview save WITH a matching sourceGenerationId but edited text -> origin 'generated_edited'", async () => {
    mockTxGenerationFindUnique.mockResolvedValue({
      cwid: "self01",
      text: "<p>Original draft.</p>",
      model: "anthropic/claude-sonnet-4.5",
    });
    const res = await POST(
      post({
        entityType: "scholar",
        entityId: "self01",
        fieldName: "overview",
        value: "<p>Edited afterwards.</p>",
        sourceGenerationId: "gen1",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxProvenanceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          origin: "generated_edited",
          model: "anthropic/claude-sonnet-4.5",
          sourceGenerationId: "gen1",
        }),
      }),
    );
  });

  it("overview save WITHOUT a sourceGenerationId -> origin 'authored' (model/source null)", async () => {
    const res = await POST(
      post({ entityType: "scholar", entityId: "self01", fieldName: "overview", value: "<p>Hand-authored.</p>" }),
    );
    expect(res.status).toBe(200);
    expect(mockTxGenerationFindUnique).not.toHaveBeenCalled();
    expect(mockTxProvenanceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          origin: "authored",
          model: null,
          sourceGenerationId: null,
        }),
      }),
    );
  });

  it("overview save with a MISSING generation -> origin 'authored' (provenance never fails the save)", async () => {
    mockTxGenerationFindUnique.mockResolvedValue(null);
    const res = await POST(
      post({
        entityType: "scholar",
        entityId: "self01",
        fieldName: "overview",
        value: "<p>x</p>",
        sourceGenerationId: "ghost",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxProvenanceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ origin: "authored", model: null, sourceGenerationId: null }),
      }),
    );
  });

  it("overview save with a FOREIGN generation (other cwid) -> origin 'authored'", async () => {
    mockTxGenerationFindUnique.mockResolvedValue({
      cwid: "other9", // belongs to a different scholar
      text: "<p>x</p>",
      model: "anthropic/claude-sonnet-4.5",
    });
    const res = await POST(
      post({
        entityType: "scholar",
        entityId: "self01",
        fieldName: "overview",
        value: "<p>x</p>",
        sourceGenerationId: "gen1",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockTxProvenanceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ origin: "authored", model: null, sourceGenerationId: null }),
      }),
    );
  });

  it("a NON-overview save (slug) does NOT upsert provenance", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(
      post({ entityType: "scholar", entityId: "sch5", fieldName: "slug", value: "new-slug" }),
    );
    expect(res.status).toBe(200);
    expect(mockTxProvenanceUpsert).not.toHaveBeenCalled();
    expect(mockTxGenerationFindUnique).not.toHaveBeenCalled();
  });
});
