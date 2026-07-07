import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
  // Amendment 4 — the unit-admin resolver (resolveEditableUnitViaUnitAdmin)
  // reads these on the non-self overview path before denying.
  mockScholarFindUnique,
  mockDivisionMembershipFindMany,
  mockDivisionFindMany,
  mockUnitAdminFindMany,
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
  mockScholarFindUnique: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
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
      scholar: { findFirst: mockScholarFindFirst, findUnique: mockScholarFindUnique },
      fieldOverride: { findFirst: mockFieldOverrideFindFirst },
      slugHistory: { findFirst: mockSlugHistoryFindFirst },
      // #779 — the non-self overview path now probes for a proxy grant before
      // denying; no grant in these self/superuser tests, so it returns null.
      scholarProxy: { findUnique: async () => null },
      // Amendment 4 — and then for a unit-admin role over a unit the scholar
      // belongs to. Deny by default (no scholar row ⇒ resolver returns null).
      divisionMembership: { findMany: mockDivisionMembershipFindMany },
      division: { findMany: mockDivisionFindMany },
      unitAdmin: { findMany: mockUnitAdminFindMany },
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
  // Amendment 4 — default: no unit-admin access (the resolver short-circuits on
  // a missing scholar row, so a non-self overview edit still denies with 403).
  mockScholarFindUnique.mockResolvedValue(null);
  mockDivisionMembershipFindMany.mockResolvedValue([]);
  mockDivisionFindMany.mockResolvedValue([]);
  mockUnitAdminFindMany.mockResolvedValue([]);
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

  // #955 item 4 — the best-effort profanity screen the self-serve slug-request
  // path enforces (`validateRequestedSlug`) now also blocks the superuser/owner
  // override path here, so the override can't bypass it. Token-exact, name-safe;
  // blocks with the matching `profanity` code (400) before any write.
  it("rejects a profane slug with 400 (profanity) on the superuser override path", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(
      post({ entityType: "scholar", entityId: "sch5", fieldName: "slug", value: "john-fuck-smith" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("profanity");
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

// #844 — a superuser may edit ANY scholar's overview (previously owner-only).
// The widening is scoped to `overview`; the audit row attributes the acting
// superuser (not the target scholar) and records no impersonation.
describe("POST /api/edit/field — superuser cross-scholar overview (#844)", () => {
  it("allows a superuser editing another scholar's overview — 200, one tx + audit row", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(
      post({ entityType: "scholar", entityId: "other9", fieldName: "overview", value: "<p>Admin-authored bio.</p>" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fieldName).toBe("overview");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockFieldOverrideUpsert).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // the B03 audit row
    expect(mockReflectOverviewEdit).toHaveBeenCalled();
  });

  it("attributes the acting SUPERUSER (not the target scholar) in the audit row, no impersonation", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(
      post({ entityType: "scholar", entityId: "other9", fieldName: "overview", value: "<p>bio</p>" }),
    );
    expect(res.status).toBe(200);
    // appendAuditRow binds the positional template values after the strings
    // array: [strings, actor_cwid, target_entity_type, target_entity_id, action,
    //   fields_changed, before_values, after_values, row_hash, ts, request_id,
    //   impersonated_cwid]. The acting admin is the actor; the target is the
    //   scholar; impersonated_cwid (last positional value) is null.
    const args = mockExecuteRaw.mock.calls[0] as unknown[];
    expect(args[1]).toBe("adm001"); // actor_cwid — the acting superuser
    expect(args[3]).toBe("other9"); // target_entity_id — the edited scholar
    expect(args[args.length - 1]).toBeNull(); // impersonated_cwid — not impersonating
  });

  it("records the override + provenance against the acting superuser ('authored', no generation)", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(
      post({ entityType: "scholar", entityId: "other9", fieldName: "overview", value: "<p>bio</p>" }),
    );
    expect(res.status).toBe(200);
    // FieldOverride.actorCwid records the last writer = the acting superuser.
    expect(mockFieldOverrideUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ entityId: "other9", actorCwid: "adm001" }),
        update: expect.objectContaining({ actorCwid: "adm001" }),
      }),
    );
    // An admin save is hand-authored — no sourceGenerationId, so provenance is
    // "authored" and attributed to the superuser; the generation is never read.
    expect(mockTxGenerationFindUnique).not.toHaveBeenCalled();
    expect(mockTxProvenanceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          cwid: "other9",
          origin: "authored",
          model: null,
          sourceGenerationId: null,
          updatedByCwid: "adm001",
        }),
      }),
    );
  });

  it("does NOT record a unit-admin/proxy 'edited_via' tag for a superuser overview edit", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    const res = await POST(
      post({ entityType: "scholar", entityId: "other9", fieldName: "overview", value: "<p>bio</p>" }),
    );
    expect(res.status).toBe(200);
    // The superuser passes the primary authz gate, so the proxy / unit-admin
    // fallback branches never run — no `edited_via` is written to afterValues.
    const args = mockExecuteRaw.mock.calls[0] as unknown[];
    const edited = args.find(
      (v): v is string => typeof v === "string" && v.includes("edited_via"),
    );
    expect(edited).toBeUndefined();
  });

  it("allows a superuser to set another scholar's selectedHighlightPmids — 200 (#836 superuser widening)", async () => {
    const original = process.env.SELF_EDIT_MANUAL_HIGHLIGHTS;
    process.env.SELF_EDIT_MANUAL_HIGHLIGHTS = "on";
    mockGetEditSession.mockResolvedValue(ADMIN);
    try {
      const res = await POST(
        post({ entityType: "scholar", entityId: "other9", fieldName: "selectedHighlightPmids", value: ["100"] }),
      );
      expect(res.status).toBe(200);
      expect(mockFieldOverrideUpsert).toHaveBeenCalledTimes(1);
      expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // the B03 audit row
    } finally {
      if (original === undefined) delete process.env.SELF_EDIT_MANUAL_HIGHLIGHTS;
      else process.env.SELF_EDIT_MANUAL_HIGHLIGHTS = original;
    }
  });
});

// Amendment 4 — org-unit administrator as profile editor (scholar-proxy-unit-
// admin-amendment.md). The route-level WIRING of the unit-admin branch beside
// the #779 proxy branch (membership + cascade correctness is unit-tested in
// unit-scholar-authz.test.ts; here we drive the unitAdmin.findMany rows directly).
describe("POST /api/edit/field — unit-admin branch (Amendment 4)", () => {
  const UNIT_ADMIN = { cwid: "uadm01", isSuperuser: false };

  it("allows an owner/curator of the scholar's unit to edit overview — 200 + unit context in the audit", async () => {
    mockGetEditSession.mockResolvedValue(UNIT_ADMIN);
    // The scholar belongs to DEPT-MED; the admin holds a curator row over it.
    mockScholarFindUnique.mockResolvedValue({ deptCode: "DEPT-MED", divCode: null, deletedAt: null });
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "department", entityId: "DEPT-MED", role: "curator" },
    ]);
    const res = await POST(
      post({ entityType: "scholar", entityId: "sch001", fieldName: "overview", value: "<p>bio</p>" }),
    );
    expect(res.status).toBe(200);
    expect(mockFieldOverrideUpsert).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // the B03 audit row
    // The audit afterValues JSON carries the conferring unit (Amendment 4).
    const auditArgs = mockExecuteRaw.mock.calls[0] as unknown[];
    const afterJson = auditArgs.find(
      (v): v is string => typeof v === "string" && v.includes("edited_via"),
    );
    expect(afterJson).toContain("unit_admin");
    expect(afterJson).toContain("DEPT-MED");
  });

  it("denies a non-superuser with no unit-admin role over the scholar's unit — 403, writes nothing", async () => {
    mockGetEditSession.mockResolvedValue(UNIT_ADMIN);
    mockScholarFindUnique.mockResolvedValue({ deptCode: "DEPT-MED", divCode: null, deletedAt: null });
    mockUnitAdminFindMany.mockResolvedValue([]); // holds no row over the scholar's unit
    const res = await POST(
      post({ entityType: "scholar", entityId: "sch001", fieldName: "overview", value: "<p>bio</p>" }),
    );
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("does NOT extend the unit-admin path to a slug edit (overview-only allowlist) — 403", async () => {
    mockGetEditSession.mockResolvedValue(UNIT_ADMIN);
    // Even with a real unit-admin role, slug stays superuser-only (the branch is
    // gated to fieldName === 'overview').
    mockScholarFindUnique.mockResolvedValue({ deptCode: "DEPT-MED", divCode: null, deletedAt: null });
    mockUnitAdminFindMany.mockResolvedValue([
      { entityType: "department", entityId: "DEPT-MED", role: "owner" },
    ]);
    const res = await POST(
      post({ entityType: "scholar", entityId: "sch001", fieldName: "slug", value: "new-slug" }),
    );
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #836 — selectedHighlightPmids (opt-in manual Highlights override)
// ---------------------------------------------------------------------------

describe("POST /api/edit/field — selectedHighlightPmids (#836)", () => {
  const ORIGINAL_FLAG = process.env.SELF_EDIT_MANUAL_HIGHLIGHTS;
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.SELF_EDIT_MANUAL_HIGHLIGHTS;
    else process.env.SELF_EDIT_MANUAL_HIGHLIGHTS = ORIGINAL_FLAG;
  });

  it("rejects with 400 (invalid_field) when the flag is off — feature is dark", async () => {
    delete process.env.SELF_EDIT_MANUAL_HIGHLIGHTS;
    const res = await POST(
      post({ entityType: "scholar", entityId: "self01", fieldName: "selectedHighlightPmids", value: ["100"] }),
    );
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects a cross-scholar manual-highlights edit with 403", async () => {
    process.env.SELF_EDIT_MANUAL_HIGHLIGHTS = "on";
    const res = await POST(
      post({ entityType: "scholar", entityId: "other9", fieldName: "selectedHighlightPmids", value: ["100"] }),
    );
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects an over-the-cap array with 400 (too_many)", async () => {
    process.env.SELF_EDIT_MANUAL_HIGHLIGHTS = "on";
    const res = await POST(
      post({
        entityType: "scholar",
        entityId: "self01",
        fieldName: "selectedHighlightPmids",
        value: ["1", "2", "3", "4"],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("too_many");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("stores the normalized JSON array, writes one tx + audit row, revalidates the profile", async () => {
    process.env.SELF_EDIT_MANUAL_HIGHLIGHTS = "on";
    const res = await POST(
      post({
        entityType: "scholar",
        entityId: "self01",
        fieldName: "selectedHighlightPmids",
        value: ["300", "100"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fieldName).toBe("selectedHighlightPmids");
    // the stored value is the JSON-serialized array in pick order
    expect(body.value).toBe('["300","100"]');
    expect(mockFieldOverrideUpsert).toHaveBeenCalledTimes(1);
    expect(mockFieldOverrideUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ value: '["300","100"]' }) }),
    );
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // the B03 audit row
    expect(mockReflectOverviewEdit).toHaveBeenCalled(); // the Highlights surface lives on the profile
  });
});

// ---------------------------------------------------------------------------
// section-visibility (section-visibility-spec.md) — the seven whole-section
// hide booleans ride the same POST /api/edit/field, allowlist, and B03 audit.
// ---------------------------------------------------------------------------

describe("POST /api/edit/field — section visibility", () => {
  it("self may hide a section (hideMentoring=true): upsert 'true' + one audit row + revalidate", async () => {
    const res = await POST(
      post({ entityType: "scholar", entityId: "self01", fieldName: "hideMentoring", value: "true" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fieldName).toBe("hideMentoring");
    expect(body.value).toBe("true");
    expect(mockFieldOverrideUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ fieldName: "hideMentoring", value: "true" }),
      }),
    );
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // the B03 audit row
    expect(mockReflectOverviewEdit).toHaveBeenCalled(); // the section change alters the public profile
    // NOT a slug change → no Scholar.slug reconcile.
    expect(mockTxScholarUpdate).not.toHaveBeenCalled();
  });

  it("self may show a section (hideEducation=false): upsert 'false', still audited", async () => {
    const res = await POST(
      post({ entityType: "scholar", entityId: "self01", fieldName: "hideEducation", value: "false" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value).toBe("false");
    expect(mockFieldOverrideUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ fieldName: "hideEducation", value: "false" }),
      }),
    );
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects hideDisclosures with 400 (off the allowlist — COI is never hideable)", async () => {
    const res = await POST(
      post({ entityType: "scholar", entityId: "self01", fieldName: "hideDisclosures", value: "true" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_field");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean section value with 400 (invalid_value)", async () => {
    const res = await POST(
      post({ entityType: "scholar", entityId: "self01", fieldName: "hideMethods", value: "yes" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_value");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects a cross-scholar section hide with 403 and writes nothing", async () => {
    const res = await POST(
      post({ entityType: "scholar", entityId: "other9", fieldName: "hideFunding", value: "true" }),
    );
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
