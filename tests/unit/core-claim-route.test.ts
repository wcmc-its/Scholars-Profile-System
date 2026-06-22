/**
 * POST /api/edit/core-claim — handler-level coverage, focused on the Tier-3
 * `status:"revoked"` soft-revoke (undo) branch and its interaction with the
 * existing claim/writeback path. readEditRequest is mocked to inject a parsed
 * context; editOk/editError stay real so status codes are exercised. DB +
 * audit + engine writeback are mocked.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockReadEditRequest,
  mockCoreFindUnique,
  mockClaimFindUnique,
  mockUnitAdminFindUnique,
  mockTransaction,
  mockClaimUpsert,
  mockClaimUpdate,
  mockAppendAuditRow,
  mockWriteBack,
} = vi.hoisted(() => ({
  mockReadEditRequest: vi.fn(),
  mockCoreFindUnique: vi.fn(),
  mockClaimFindUnique: vi.fn(),
  mockUnitAdminFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockClaimUpsert: vi.fn(),
  mockClaimUpdate: vi.fn(),
  mockAppendAuditRow: vi.fn(),
  mockWriteBack: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: mockAppendAuditRow }));
vi.mock("@/lib/cores/claim-writeback", () => ({ writeBackCoreClaim: mockWriteBack }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      core: { findUnique: mockCoreFindUnique },
      coreClaim: { findUnique: mockClaimFindUnique },
      unitAdmin: { findUnique: mockUnitAdminFindUnique },
    },
    write: { $transaction: mockTransaction },
  },
}));

import { POST } from "@/app/api/edit/core-claim/route";

const ACTOR = "rev01";

function req(): NextRequest {
  return new NextRequest("http://localhost/api/edit/core-claim", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: "{}",
  });
}

// Configure the injected request context for one call (superuser, so authz passes).
async function call(bodyOver: Record<string, unknown> = {}) {
  mockReadEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session: { cwid: ACTOR, isSuperuser: true, isCommsSteward: false },
      realCwid: ACTOR,
      impersonatedCwid: null,
      requestId: "req-1",
      body: { pmid: "30418319", coreId: "2", status: "revoked", ...bodyOver },
    },
  });
  return POST(req());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockCoreFindUnique.mockResolvedValue({ id: "2" });
  mockUnitAdminFindUnique.mockResolvedValue(null); // role none; superuser session allows
  // Default: an active (un-revoked) claim exists.
  mockClaimFindUnique.mockResolvedValue({ status: "claimed", revokedAt: null, note: null });
  mockClaimUpsert.mockResolvedValue({});
  mockClaimUpdate.mockResolvedValue({});
  mockAppendAuditRow.mockResolvedValue(undefined);
  mockWriteBack.mockResolvedValue({ ok: true, skipped: false });
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ coreClaim: { upsert: mockClaimUpsert, update: mockClaimUpdate } }),
  );
});

describe("POST /api/edit/core-claim — revoke (undo) branch", () => {
  it("soft-revokes an active claim + writes a core_claim audit row in one tx, no writeback", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pmid: "30418319", coreId: "2", status: "revoked" });

    const update = mockClaimUpdate.mock.calls[0][0];
    expect(update.where).toEqual({ pmid_coreId: { pmid: "30418319", coreId: "2" } });
    expect(update.data.revokedBy).toBe(ACTOR);
    expect(update.data.revokedAt).toBeInstanceOf(Date);

    const row = mockAppendAuditRow.mock.calls[0][1];
    expect(row.action).toBe("core_claim");
    expect(row.fieldsChanged).toEqual(["revoked"]);
    expect(row.beforeValues).toEqual({ status: "claimed", revoked: false });
    expect(row.afterValues).toEqual({ revoked: true });
    expect(row.actorCwid).toBe(ACTOR);
    expect(row.impersonatedCwid).toBeNull();

    // revoke must NOT mirror to the engine (the nightly run re-derives).
    expect(mockWriteBack).not.toHaveBeenCalled();
  });

  it("is a no-op (200 unchanged) with NO transaction when there is no claim", async () => {
    mockClaimFindUnique.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unchanged: true });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockWriteBack).not.toHaveBeenCalled();
  });

  it("is a no-op (200 unchanged) with NO transaction when the claim is already revoked", async () => {
    mockClaimFindUnique.mockResolvedValue({ status: "claimed", revokedAt: new Date(), note: null });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unchanged: true });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 500 write_failed when the revoke transaction throws", async () => {
    mockTransaction.mockRejectedValue(new Error("db down"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "write_failed" });
  });
});

describe("POST /api/edit/core-claim — claim path + validation", () => {
  it("a claim upserts the override and DOES mirror to the engine writeback", async () => {
    mockClaimFindUnique.mockResolvedValue(null); // no existing → not idempotent
    const res = await call({ status: "claimed" });
    expect(res.status).toBe(200);
    expect(mockClaimUpsert).toHaveBeenCalledTimes(1);
    expect(mockWriteBack).toHaveBeenCalledWith({ pmid: "30418319", coreId: "2", status: "claimed" });
  });

  it("rejects an unknown action with 400 invalid_status (before any DB write)", async () => {
    const res = await call({ status: "bogus" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_status" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
