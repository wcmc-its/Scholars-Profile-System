/**
 * `/api/edit/opportunity-admin` route wiring (matcha-admin Phase 1b):
 *  - 404 while MATCHA_ADMIN is off (dark-ship posture);
 *  - dev-role gate (superuser OR isDeveloper) + denial log;
 *  - body validation (opportunityId shape, action allowlist), unknown row 404;
 *  - suppress writes the three suppression fields + a `suppression_create`
 *    audit row on the new `opportunity` entity type, in one transaction;
 *  - restore nulls all three + `suppression_revoke`;
 *  - no-op guards: 409 already_suppressed / not_suppressed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const {
  mockReadEditRequest,
  mockOpportunityFindUnique,
  mockOpportunityUpdate,
  mockTransaction,
  mockAppendAuditRow,
  mockLogEditDenial,
} = vi.hoisted(() => ({
  mockReadEditRequest: vi.fn(),
  mockOpportunityFindUnique: vi.fn(),
  mockOpportunityUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockLogEditDenial: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: { opportunity: { findUnique: mockOpportunityFindUnique } },
    write: { $transaction: mockTransaction },
  },
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogEditDenial }));

import { PATCH } from "@/app/api/edit/opportunity-admin/route";

const developerCtx = {
  session: { cwid: "flm4001", isSuperuser: false, isDeveloper: true },
  effective: { cwid: "flm4001", isSuperuser: false, isDeveloper: true },
  realCwid: "flm4001",
  impersonatedCwid: null,
  requestId: "req-1",
  body: {} as Record<string, unknown>,
};

function patchRequest(body: Record<string, unknown>) {
  mockReadEditRequest.mockResolvedValue({ ok: true, ctx: { ...developerCtx, body } });
  return {} as NextRequest;
}

const OPP_ID = "manual_url:x-abc123";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MATCHA_ADMIN = "on";
  mockOpportunityFindUnique.mockResolvedValue({
    suppressedAt: null,
    suppressedBy: null,
    suppressReason: null,
  });
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
    fn({ opportunity: { update: mockOpportunityUpdate } }),
  );
});

describe("flag gate", () => {
  it("404s while MATCHA_ADMIN is off, before any preamble work", async () => {
    process.env.MATCHA_ADMIN = "off";
    const res = await PATCH(patchRequest({ opportunityId: OPP_ID, action: "suppress" }));
    expect(res.status).toBe(404);
    expect(mockReadEditRequest).not.toHaveBeenCalled();
  });
});

describe("authorization", () => {
  it("passes the preamble's error response through (no session)", async () => {
    const { NextResponse } = await import("next/server");
    mockReadEditRequest.mockResolvedValue({
      ok: false,
      response: new NextResponse(null, { status: 401 }),
    });
    const res = await PATCH({} as NextRequest);
    expect(res.status).toBe(401);
    expect(mockOpportunityFindUnique).not.toHaveBeenCalled();
  });

  it("403s + logs a denial for a non-developer", async () => {
    mockReadEditRequest.mockResolvedValue({
      ok: true,
      ctx: {
        ...developerCtx,
        session: { cwid: "abc1234", isSuperuser: false, isDeveloper: false },
        body: { opportunityId: OPP_ID, action: "suppress" },
      },
    });
    const res = await PATCH({} as NextRequest);
    expect(res.status).toBe(403);
    expect(mockLogEditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "not_developer_patch" }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("validation", () => {
  it("400s a missing/malformed opportunityId and an unknown action", async () => {
    const missing = await PATCH(patchRequest({ action: "suppress" }));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe("invalid_opportunity_id");

    const malformed = await PATCH(patchRequest({ opportunityId: "bad id!", action: "suppress" }));
    expect(malformed.status).toBe(400);

    const badAction = await PATCH(patchRequest({ opportunityId: OPP_ID, action: "hide" }));
    expect(badAction.status).toBe(400);
    expect((await badAction.json()).error).toBe("invalid_action");
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("404s an unknown opportunity", async () => {
    mockOpportunityFindUnique.mockResolvedValue(null);
    const res = await PATCH(patchRequest({ opportunityId: OPP_ID, action: "suppress" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });
});

describe("suppress", () => {
  it("writes the three suppression fields + the opportunity audit row in one transaction", async () => {
    const res = await PATCH(
      patchRequest({ opportunityId: OPP_ID, action: "suppress", reason: "  dup of NOFO  " }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, opportunityId: OPP_ID, action: "suppress" });

    expect(mockOpportunityUpdate).toHaveBeenCalledWith({
      where: { opportunityId: OPP_ID },
      data: {
        suppressedAt: expect.any(Date),
        suppressedBy: "flm4001",
        suppressReason: "dup of NOFO",
      },
    });
    expect(mockAppendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorCwid: "flm4001",
        targetEntityType: "opportunity",
        targetEntityId: OPP_ID,
        action: "suppression_create",
        beforeValues: { suppressed_at: null, suppressed_by: null, suppress_reason: null },
        afterValues: expect.objectContaining({
          suppressed_by: "flm4001",
          suppress_reason: "dup of NOFO",
        }),
      }),
    );
  });

  it("suppresses without a reason (null) and 409s an already-suppressed row", async () => {
    const res = await PATCH(patchRequest({ opportunityId: OPP_ID, action: "suppress" }));
    expect(res.status).toBe(200);
    expect(mockOpportunityUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ suppressReason: null }) }),
    );

    mockOpportunityFindUnique.mockResolvedValue({
      suppressedAt: new Date("2026-08-01T00:00:00Z"),
      suppressedBy: "zzz9999",
      suppressReason: null,
    });
    const twice = await PATCH(patchRequest({ opportunityId: OPP_ID, action: "suppress" }));
    expect(twice.status).toBe(409);
    expect((await twice.json()).error).toBe("already_suppressed");
  });

  it("500s (write_failed) when the transaction fails", async () => {
    mockTransaction.mockRejectedValue(new Error("mysql down"));
    const res = await PATCH(patchRequest({ opportunityId: OPP_ID, action: "suppress" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("write_failed");
  });
});

describe("restore", () => {
  it("nulls all three fields + appends suppression_revoke with the prior state", async () => {
    mockOpportunityFindUnique.mockResolvedValue({
      suppressedAt: new Date("2026-08-01T00:00:00.000Z"),
      suppressedBy: "zzz9999",
      suppressReason: "mistake",
    });
    const res = await PATCH(patchRequest({ opportunityId: OPP_ID, action: "restore" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, opportunityId: OPP_ID, action: "restore" });

    expect(mockOpportunityUpdate).toHaveBeenCalledWith({
      where: { opportunityId: OPP_ID },
      data: { suppressedAt: null, suppressedBy: null, suppressReason: null },
    });
    expect(mockAppendAuditRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetEntityType: "opportunity",
        action: "suppression_revoke",
        beforeValues: {
          suppressed_at: "2026-08-01T00:00:00.000Z",
          suppressed_by: "zzz9999",
          suppress_reason: "mistake",
        },
        afterValues: { suppressed_at: null, suppressed_by: null, suppress_reason: null },
      }),
    );
  });

  it("409s restoring a row that is not suppressed", async () => {
    const res = await PATCH(patchRequest({ opportunityId: OPP_ID, action: "restore" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_suppressed");
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
