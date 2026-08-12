/**
 * `POST /api/edit/center/[code]/disease-assignments` — a curator's confirm /
 * reject / clear call on one (cwid, diseaseCode) `CancerCenterDiseaseAssignment`
 * row (`2026-08-12-cancer-center-disease-assignment-edit-ui-plan.md` §4).
 *
 * The one guardrail this file exists to lock down: `"clear"` is a REAL DELETE
 * of the `CancerCenterDiseaseDecision` row, never a third stored `decision`
 * value — the exact bug class `FamilyTierDecision` (#1993/#2160) was built to
 * close, and this table copies that shape on purpose. Also covers `decidedBy`
 * always being the REAL accountable actor, never the impersonated cwid.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockCenterFindUnique,
  mockUnitAdminFindMany,
  mockReadDecisionFindUnique,
  mockTransaction,
  mockTxAssignmentFindUnique,
  mockTxDecisionDelete,
  mockTxDecisionUpsert,
  mockAppendAuditRow,
  mockReadEditRequest,
} = vi.hoisted(() => ({
  mockCenterFindUnique: vi.fn(),
  mockUnitAdminFindMany: vi.fn(),
  mockReadDecisionFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxAssignmentFindUnique: vi.fn(),
  mockTxDecisionDelete: vi.fn(),
  mockTxDecisionUpsert: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockReadEditRequest: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      center: { findUnique: mockCenterFindUnique },
      unitAdmin: { findMany: mockUnitAdminFindMany },
      cancerCenterDiseaseDecision: { findUnique: mockReadDecisionFindUnique },
    },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
// Keep the real `editOk`/`editError`/`logEditFailure`; only `readEditRequest`
// is driven per-test (same seam `family-tier-decision-route.test.ts` uses).
vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));

import { POST } from "@/app/api/edit/center/[code]/disease-assignments/route";

const CENTER = { code: "meyer_cancer_center" };
const CURATOR = { cwid: "cur1001", isSuperuser: false };

const fakeTx = {
  cancerCenterDiseaseAssignment: { findUnique: mockTxAssignmentFindUnique },
  cancerCenterDiseaseDecision: { delete: mockTxDecisionDelete, upsert: mockTxDecisionUpsert },
};

const CURRENT_ASSIGNMENT = { score: 42, confidence: "high" };
const EXISTING_DECISION = {
  decision: "rejected",
  scoreAtDecision: 30,
  confidenceAtDecision: "medium",
};

/** `realCwid` defaults to the session cwid (no impersonation); a test that
 *  needs the impersonation split overrides both explicitly. */
function driveRequest(
  body: unknown,
  opts?: { realCwid?: string; impersonatedCwid?: string | null; session?: typeof CURATOR },
) {
  mockReadEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session: opts?.session ?? CURATOR,
      realCwid: opts?.realCwid ?? (opts?.session ?? CURATOR).cwid,
      impersonatedCwid: opts?.impersonatedCwid ?? null,
      body,
      requestId: "req-1",
    },
  });
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edit/center/meyer_cancer_center/disease-assignments", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

function call(body: unknown, opts?: Parameters<typeof driveRequest>[1]) {
  driveRequest(body, opts);
  return POST(post(body), { params: Promise.resolve({ code: "meyer_cancer_center" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockCenterFindUnique.mockResolvedValue(CENTER);
  mockUnitAdminFindMany.mockResolvedValue([
    { entityType: "center", entityId: CENTER.code, role: "curator" },
  ]);
  mockReadDecisionFindUnique.mockResolvedValue(null);
  mockTransaction.mockImplementation(async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx));
  mockTxAssignmentFindUnique.mockResolvedValue(CURRENT_ASSIGNMENT);
  mockTxDecisionUpsert.mockResolvedValue({
    decision: "confirmed",
    scoreAtDecision: CURRENT_ASSIGNMENT.score,
    confidenceAtDecision: CURRENT_ASSIGNMENT.confidence,
  });
});

describe("POST /api/edit/center/[code]/disease-assignments — validation", () => {
  it("400s an invalid cwid", async () => {
    const res = await call({ cwid: "1bad", diseaseCode: "BREAST", decision: "confirmed" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_cwid");
  });

  it("400s an empty disease code", async () => {
    const res = await call({ cwid: "fac001", diseaseCode: "", decision: "confirmed" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_disease_code");
  });

  it("400s an invalid decision value", async () => {
    const res = await call({ cwid: "fac001", diseaseCode: "BREAST", decision: "maybe" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_decision");
  });

  it("400s a disease code that isn't in the canonical taxonomy — before any authz/DB work", async () => {
    const res = await call({ cwid: "fac001", diseaseCode: "NOT_A_REAL_CODE", decision: "confirmed" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_disease_code");
    expect(mockCenterFindUnique).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400s an unknown center code", async () => {
    mockCenterFindUnique.mockResolvedValue(null);
    const res = await call({ cwid: "fac001", diseaseCode: "BREAST", decision: "confirmed" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unit_not_found");
  });

  it("403s a non-curator, non-superuser caller — no writes reached", async () => {
    mockUnitAdminFindMany.mockResolvedValue([]);
    const res = await call(
      { cwid: "fac001", diseaseCode: "BREAST", decision: "confirmed" },
      { session: { cwid: "non001", isSuperuser: false } },
    );
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("POST .../disease-assignments — clear is a REAL DELETE, never a third decision value", () => {
  it("clearing an already-absent decision is a 200 no-op — no transaction, no audit row", async () => {
    mockReadDecisionFindUnique.mockResolvedValue(null);
    const res = await call({ cwid: "fac001", diseaseCode: "BREAST", decision: "clear" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, changed: false });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockAppendAuditRow).not.toHaveBeenCalled();
  });

  it("clearing an existing decision calls .delete — never .upsert/.update/.create with a 'clear' value", async () => {
    mockReadDecisionFindUnique.mockResolvedValue(EXISTING_DECISION);
    const res = await call({ cwid: "fac001", diseaseCode: "BREAST", decision: "clear" });
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toBe(true);

    expect(mockTxDecisionDelete).toHaveBeenCalledTimes(1);
    expect(mockTxDecisionDelete).toHaveBeenCalledWith({
      where: { cwid_diseaseCode: { cwid: "fac001", diseaseCode: "BREAST" } },
    });
    // The bug class this locks down: "clear" must never appear as a written
    // `decision` value anywhere — only a delete.
    expect(mockTxDecisionUpsert).not.toHaveBeenCalled();
  });

  it("the audit row for a clear carries the prior decision as before, and null after — no sentinel value", async () => {
    mockReadDecisionFindUnique.mockResolvedValue(EXISTING_DECISION);
    await call({ cwid: "fac001", diseaseCode: "BREAST", decision: "clear" });

    expect(mockAppendAuditRow).toHaveBeenCalledTimes(1);
    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.action).toBe("disease_assignment_decision");
    expect(row.targetEntityType).toBe("scholar");
    expect(row.targetEntityId).toBe("fac001");
    expect(row.beforeValues).toMatchObject({ diseaseCode: "BREAST", decision: "rejected" });
    expect(row.afterValues).toBeNull();
  });

  it("a cleared pair reads back with no row at all — findUnique returns null, not a 'clear' row", async () => {
    // Simulates the post-delete state a subsequent GET would see: the mock's
    // own read-path returns null, exactly like a genuinely-absent row would.
    mockReadDecisionFindUnique.mockResolvedValue(null);
    const res = await call({ cwid: "fac001", diseaseCode: "BREAST", decision: "clear" });
    expect((await res.json()).changed).toBe(false);
  });
});

describe("POST .../disease-assignments — confirm / reject", () => {
  it("404s reject when the pair has no current assignment row — nothing to reject", async () => {
    mockTxAssignmentFindUnique.mockResolvedValue(null);
    const res = await call({ cwid: "fac001", diseaseCode: "BREAST", decision: "rejected" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("assignment_not_found");
    expect(mockTxDecisionUpsert).not.toHaveBeenCalled();
    expect(mockAppendAuditRow).not.toHaveBeenCalled();
  });

  it("manual add: confirming with no current assignment row succeeds with null score/confidence + a real audit row", async () => {
    mockTxAssignmentFindUnique.mockResolvedValue(null);
    mockTxDecisionUpsert.mockResolvedValue({
      decision: "confirmed",
      scoreAtDecision: null,
      confidenceAtDecision: null,
    });
    const res = await call({ cwid: "fac001", diseaseCode: "BREAST", decision: "confirmed" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      cwid: "fac001",
      diseaseCode: "BREAST",
      decision: "confirmed",
      scoreAtDecision: null,
      confidenceAtDecision: null,
    });

    expect(mockTxDecisionUpsert).toHaveBeenCalledTimes(1);
    const call1 = mockTxDecisionUpsert.mock.calls[0][0];
    expect(call1.create).toMatchObject({
      cwid: "fac001",
      diseaseCode: "BREAST",
      decision: "confirmed",
      decidedBy: "cur1001",
      scoreAtDecision: null,
      confidenceAtDecision: null,
    });
    expect(call1.update).toMatchObject({ scoreAtDecision: null, confidenceAtDecision: null });

    // A real, complete audit row — not skipped just because there's nothing
    // to snapshot.
    expect(mockAppendAuditRow).toHaveBeenCalledTimes(1);
    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.action).toBe("disease_assignment_decision");
    expect(row.targetEntityType).toBe("scholar");
    expect(row.targetEntityId).toBe("fac001");
    expect(row.afterValues).toMatchObject({
      diseaseCode: "BREAST",
      decision: "confirmed",
      scoreAtDecision: null,
      confidenceAtDecision: null,
    });
  });

  it("confirms, upserting decidedBy + snapshotting the CURRENT assignment score/confidence", async () => {
    const res = await call({ cwid: "fac001", diseaseCode: "BREAST", decision: "confirmed" });
    expect(res.status).toBe(200);

    expect(mockTxDecisionUpsert).toHaveBeenCalledTimes(1);
    const call1 = mockTxDecisionUpsert.mock.calls[0][0];
    expect(call1.where).toEqual({ cwid_diseaseCode: { cwid: "fac001", diseaseCode: "BREAST" } });
    expect(call1.create).toMatchObject({
      cwid: "fac001",
      diseaseCode: "BREAST",
      decision: "confirmed",
      decidedBy: "cur1001",
      scoreAtDecision: CURRENT_ASSIGNMENT.score,
      confidenceAtDecision: CURRENT_ASSIGNMENT.confidence,
    });
    expect(call1.update).toMatchObject({
      decision: "confirmed",
      decidedBy: "cur1001",
      scoreAtDecision: CURRENT_ASSIGNMENT.score,
      confidenceAtDecision: CURRENT_ASSIGNMENT.confidence,
    });
  });

  it("rejects the same way, with its own decision value", async () => {
    mockTxDecisionUpsert.mockResolvedValue({
      decision: "rejected",
      scoreAtDecision: CURRENT_ASSIGNMENT.score,
      confidenceAtDecision: CURRENT_ASSIGNMENT.confidence,
    });
    const res = await call({ cwid: "fac001", diseaseCode: "BREAST", decision: "rejected" });
    expect(res.status).toBe(200);
    expect(mockTxDecisionUpsert.mock.calls[0][0].create).toMatchObject({ decision: "rejected" });
  });

  it("decidedBy is the REAL accountable actor — never the impersonated cwid", async () => {
    await call(
      { cwid: "fac001", diseaseCode: "BREAST", decision: "confirmed" },
      { realCwid: "super001", impersonatedCwid: "cur1001", session: { cwid: "cur1001", isSuperuser: true } },
    );
    const upsertCall = mockTxDecisionUpsert.mock.calls[0][0];
    expect(upsertCall.create.decidedBy).toBe("super001");
    expect(upsertCall.update.decidedBy).toBe("super001");

    // The audit row's actor is the same real cwid; the impersonated cwid rides
    // along on its own dedicated field, never substituted in as the actor.
    const auditRow = mockAppendAuditRow.mock.calls[0][1];
    expect(auditRow.actorCwid).toBe("super001");
    expect(auditRow.impersonatedCwid).toBe("cur1001");
  });

  it("shares one timestamp between the decision row and the audit row", async () => {
    await call({ cwid: "fac001", diseaseCode: "BREAST", decision: "confirmed" });
    const decidedAt = mockTxDecisionUpsert.mock.calls[0][0].create.decidedAt;
    const auditTs = mockAppendAuditRow.mock.calls[0][1].ts;
    expect(decidedAt).toBeInstanceOf(Date);
    expect(auditTs.getTime()).toBe(decidedAt.getTime());
  });
});
