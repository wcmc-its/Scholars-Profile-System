/**
 * `POST /api/edit/methods/families/tier` — #1993.
 *
 * The route's overlay-membership writes were already covered by manual/E2E
 * verification; this file locks down the piece #1993 adds: a `FamilyTierDecision`
 * upsert in the SAME transaction as the overlay write, for EVERY tier — including
 * "public", the one transition that leaves no row in either overlay table at all.
 * Without this write, a steward's Public decision is indistinguishable from a
 * family the curated CSV has simply never mentioned, and the next
 * `etl:family-sensitivity` / `etl:family-suppression` reseed silently resurrects
 * it as `source='seed'`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  tx: {
    familySuppressionOverlay: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    familySensitivityOverlay: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    familyTierDecision: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: h.readEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));
vi.mock("@/lib/api/swr-cache", () => ({ bust: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { write: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(h.tx)) } },
}));

import { POST } from "@/app/api/edit/methods/families/tier/route";

const SUPERCATEGORY = "animal_cell_models";
const FAMILY_LABEL = "Xenograft tumor models";
const STEWARD = { cwid: "cur1001", isSuperuser: false, isCommsSteward: true };

function request(tier: string) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session: STEWARD,
      realCwid: "cur1001",
      impersonatedCwid: null,
      body: { supercategory: SUPERCATEGORY, familyLabel: FAMILY_LABEL, tier },
      requestId: "req-1",
    },
  });
  return new Request("http://x/api/edit/methods/families/tier", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.COMMS_STEWARD_ENABLED = "on";
  h.tx.familySuppressionOverlay.findUnique.mockResolvedValue(null);
  h.tx.familySensitivityOverlay.findUnique.mockResolvedValue(null);
});

describe("FamilyTierDecision (#1993)", () => {
  it("upserts a decision row when the tier is set to public — the case with NO overlay row", async () => {
    // This is the entire point of #1993: "public" leaves nothing in either
    // overlay table, so this upsert is the ONLY durable trace of the decision.
    const res = await POST(request("public") as never);
    expect(res.status).toBe(200);
    expect(h.tx.familyTierDecision.upsert).toHaveBeenCalledTimes(1);
    const call = h.tx.familyTierDecision.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      supercategory_familyLabel: { supercategory: SUPERCATEGORY, familyLabel: FAMILY_LABEL },
    });
    expect(call.create).toMatchObject({
      supercategory: SUPERCATEGORY,
      familyLabel: FAMILY_LABEL,
      tier: "public",
      decidedBy: "cur1001",
    });
    expect(call.update).toMatchObject({ tier: "public", decidedBy: "cur1001" });
  });

  it("upserts a decision row when the tier is set to suppressed", async () => {
    const res = await POST(request("suppressed") as never);
    expect(res.status).toBe(200);
    expect(h.tx.familyTierDecision.upsert.mock.calls[0][0].create).toMatchObject({
      tier: "suppressed",
    });
  });

  it("upserts a decision row when the tier is set to sensitive", async () => {
    const res = await POST(request("sensitive") as never);
    expect(res.status).toBe(200);
    expect(h.tx.familyTierDecision.upsert.mock.calls[0][0].create).toMatchObject({
      tier: "sensitive",
    });
  });

  it("shares one timestamp between the decision row and the audit row", async () => {
    await POST(request("public") as never);
    const decidedAt = h.tx.familyTierDecision.upsert.mock.calls[0][0].create.decidedAt;
    const auditTs = h.appendAuditRow.mock.calls[0][1].ts;
    expect(decidedAt).toBeInstanceOf(Date);
    expect(auditTs.getTime()).toBe(decidedAt.getTime());
  });

  it("writes the decision row BEFORE the audit row, inside the same transaction", async () => {
    const order: string[] = [];
    h.tx.familyTierDecision.upsert.mockImplementation(async () => {
      order.push("decision");
    });
    h.appendAuditRow.mockImplementation(async () => {
      order.push("audit");
    });
    await POST(request("public") as never);
    expect(order).toEqual(["decision", "audit"]);
  });

  it("does not write a decision row when the flag is off (route 404s first)", async () => {
    process.env.COMMS_STEWARD_ENABLED = "off";
    const res = await POST(request("public") as never);
    expect(res.status).toBe(404);
    expect(h.tx.familyTierDecision.upsert).not.toHaveBeenCalled();
  });
});
