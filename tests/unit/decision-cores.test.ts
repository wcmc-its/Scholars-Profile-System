/**
 * The decision cores the /edit queue routes and etl/bulk-confirm-strong share
 * (lib/edit/honor-decision.ts, news-mention-decision.ts,
 * grant-attribution-decision.ts), called directly over a fake transaction.
 * The routes' own tests cover the gates; these pin what the job relies on:
 * an approve / confirm of a pending row writes the decision as the given
 * actor with the given request id, and a row that is no longer pending is
 * refused with nothing written.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ appendAuditRow: vi.fn() }));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));

import { decideGrantReview, GrantAttributionRefused } from "@/lib/edit/grant-attribution-decision";
import { decideHonor } from "@/lib/edit/honor-decision";
import { decideNewsMention } from "@/lib/edit/news-mention-decision";

const TS = new Date("2026-11-12T15:00:00.000Z");
const ACTOR = { realCwid: "cur1001", impersonatedCwid: null, requestId: "bulk-strong-x" };

beforeEach(() => vi.clearAllMocks());

describe("decideHonor", () => {
  const ROW = {
    id: "honor-1",
    cwid: "abc1001",
    status: "pending",
    name: "Example Fellowship",
    organization: "Example Society",
    year: 2020,
    sourceRef: "https://example.org/list|Example Person|x",
  };
  const tx = {
    honor: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  };
  beforeEach(() => {
    tx.honor.findUnique.mockResolvedValue({ ...ROW });
    tx.honor.findFirst.mockResolvedValue(null);
    tx.honor.findMany.mockResolvedValue([]);
    tx.honor.update.mockImplementation(async ({ data }: { data: object }) => ({ ...ROW, ...data }));
  });

  it("approves a pending row as the actor, one audit row, no siblings", async () => {
    const r = await decideHonor(tx as never, {
      ...ACTOR,
      id: "honor-1",
      decision: "approve",
      reason: null,
      ts: TS,
    });
    expect(r).toEqual({
      kind: "ok",
      status: "published",
      siblingsRejected: 0,
      affectedCwids: ["abc1001"],
    });
    expect(tx.honor.update).toHaveBeenCalledWith({
      where: { id: "honor-1" },
      data: expect.objectContaining({
        status: "published",
        decidedByCwid: "cur1001",
        decidedAt: TS,
      }),
    });
    expect(h.appendAuditRow).toHaveBeenCalledTimes(1);
    expect(h.appendAuditRow.mock.calls[0][1]).toMatchObject({
      actorCwid: "cur1001",
      action: "honor_update",
      requestId: "bulk-strong-x",
      ts: TS,
    });
  });

  it("refuses a row decided since it was listed, writing nothing", async () => {
    tx.honor.findUnique.mockResolvedValue({ ...ROW, status: "published" });
    const r = await decideHonor(tx as never, {
      ...ACTOR,
      id: "honor-1",
      decision: "approve",
      reason: null,
      ts: TS,
    });
    expect(r).toEqual({ kind: "not_pending", status: "published" });
    expect(tx.honor.update).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });
});

describe("decideNewsMention", () => {
  const ROW = {
    id: "nm-1",
    cwid: "abc1001",
    url: "https://news.example.org/story",
    status: "pending",
    title: "A story",
    detectedName: "Example Person",
    sourceRef: "https://news.example.org/story|example person",
    showOnProfile: true,
    enteredByCwid: null,
    decisionId: null,
    outlet: null,
  };
  const tx = {
    newsMention: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    scholar: { findFirst: vi.fn() },
  };
  const args = {
    ...ACTOR,
    mentionId: "nm-1",
    decision: "approve" as const,
    reassignCwid: null,
    decisionId: "d-1",
    ts: TS,
  };
  beforeEach(() => {
    tx.newsMention.findUnique.mockResolvedValue({ ...ROW });
    tx.newsMention.findFirst.mockResolvedValue(null);
    tx.newsMention.findMany.mockResolvedValue([]);
    tx.newsMention.update.mockImplementation(async ({ data }: { data: object }) => ({
      ...ROW,
      ...data,
    }));
  });

  it("approves a pending row as the actor with the undo stamp", async () => {
    const r = await decideNewsMention(tx as never, args);
    expect(r).toMatchObject({
      kind: "ok",
      status: "published",
      showOnProfile: true,
      siblingsRejected: 0,
      reassigned: null,
      affectedCwids: ["abc1001"],
    });
    expect(tx.newsMention.update).toHaveBeenCalledWith({
      where: { id: "nm-1" },
      data: expect.objectContaining({
        status: "published",
        enteredByCwid: "cur1001",
        decisionId: "d-1",
        prevStatus: "pending",
      }),
    });
    expect(h.appendAuditRow).toHaveBeenCalledTimes(1);
    expect(h.appendAuditRow.mock.calls[0][1]).toMatchObject({
      actorCwid: "cur1001",
      action: "news_mention_update",
      requestId: "bulk-strong-x",
    });
  });

  it("refuses a published row, writing nothing", async () => {
    tx.newsMention.findUnique.mockResolvedValue({ ...ROW, status: "published" });
    expect(await decideNewsMention(tx as never, args)).toEqual({ kind: "not_pending" });
    expect(tx.newsMention.update).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });
});

describe("decideGrantReview", () => {
  const ROW = {
    id: "rev-1",
    cwid: "t000001",
    grantExternalId: "reporter:t000001:R01XX000001",
    status: "pending",
    score: 1,
    band: "queue",
    decidedByCwid: null,
    decidedAt: null,
  };
  const tx = {
    suppression: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    grantAttributionReview: { updateMany: vi.fn() },
  };
  beforeEach(() => {
    tx.suppression.findMany.mockResolvedValue([
      { id: "sup-sys", createdBy: "system-unverified", reason: "hidden pending review" },
    ]);
    tx.suppression.updateMany.mockResolvedValue({ count: 1 });
    tx.grantAttributionReview.updateMany.mockResolvedValue({ count: 1 });
  });

  it("confirms: lifts the system hide as the actor, claims the review, audits", async () => {
    const r = await decideGrantReview(tx as never, { ...ROW } as never, {
      ...ACTOR,
      decision: "confirm",
      reason: null,
      ts: TS,
    });
    expect(r).toEqual({
      entityId: ROW.grantExternalId,
      suppressions: [{ suppressionId: "sup-sys", entityId: ROW.grantExternalId }],
    });
    expect(tx.suppression.updateMany).toHaveBeenCalledWith({
      where: { id: "sup-sys", revokedAt: null },
      data: { revokedAt: TS, revokedBy: "cur1001", searchReflectedAt: null },
    });
    expect(tx.grantAttributionReview.updateMany).toHaveBeenCalledWith({
      where: { id: "rev-1", status: "pending" },
      data: expect.objectContaining({
        status: "confirmed",
        decidedByCwid: "cur1001",
        decidedAt: TS,
      }),
    });
    expect(h.appendAuditRow.mock.calls[0][1]).toMatchObject({
      actorCwid: "cur1001",
      action: "grant_attribution_confirm",
      requestId: "bulk-strong-x",
    });
  });

  it("throws not_pending on a decided review, writing nothing", async () => {
    await expect(
      decideGrantReview(tx as never, { ...ROW, status: "confirmed" } as never, {
        ...ACTOR,
        decision: "confirm",
        reason: null,
        ts: TS,
      }),
    ).rejects.toMatchObject({ code: "not_pending", status: 409 });
    expect(tx.suppression.updateMany).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("is a GrantAttributionRefused, so the route maps it to its 409", async () => {
    const err = await decideGrantReview(tx as never, { ...ROW, status: "rejected" } as never, {
      ...ACTOR,
      decision: "confirm",
      reason: null,
      ts: TS,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrantAttributionRefused);
  });
});
