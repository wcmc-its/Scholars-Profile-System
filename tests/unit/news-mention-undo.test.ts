/**
 * `POST /api/edit/news-mention/undo` — the queues' status-bar Undo. It restores
 * every row a decision stamped, all or nothing, only for the reviewer who made
 * it, only inside the window, and never over a newer write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  reflectVisibilityChange: vi.fn(),
  resolveAffectedProfiles: vi.fn(),
  tx: {
    newsMention: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: h.readEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));
vi.mock("@/lib/edit/revalidation", () => ({
  reflectVisibilityChange: h.reflectVisibilityChange,
  resolveAffectedProfiles: h.resolveAffectedProfiles,
}));
vi.mock("@/lib/db", () => ({
  db: { write: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(h.tx)) } },
}));

import { POST } from "@/app/api/edit/news-mention/undo/route";

const STEWARD = { cwid: "cms1001", isSuperuser: false, isCommsSteward: true };

function row(over: Record<string, unknown> = {}) {
  return {
    id: "news-1",
    cwid: "abc1001",
    status: "published",
    title: "An invented story",
    detectedName: "Jordan Vale",
    showOnProfile: false,
    enteredByCwid: "cms1001",
    decisionId: "req-1",
    decisionAt: new Date(Date.now() - 60_000),
    prevStatus: "pending",
    prevShowOnProfile: true,
    prevEnteredByCwid: null,
    ...over,
  };
}

function request(body: Record<string, unknown>, session: Record<string, unknown> = STEWARD) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, realCwid: "cms1001", impersonatedCwid: null, body, requestId: "req-undo" },
  });
  return new Request("http://x/api/edit/news-mention/undo", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEWS_APPROVAL_QUEUE = "on";
  h.tx.newsMention.findMany.mockResolvedValue([row()]);
  h.tx.newsMention.updateMany.mockResolvedValue({ count: 1 });
  h.tx.newsMention.deleteMany.mockResolvedValue({ count: 1 });
  h.resolveAffectedProfiles.mockImplementation(async (_t: string, cwid: string) => [
    { slug: `slug-${cwid}` },
  ]);
});

describe("restoring", () => {
  it("puts status, visibility and enteredByCwid back and clears the stamp", async () => {
    const res = await POST(request({ decisionIds: ["req-1"] }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, restored: 1 });
    expect(h.tx.newsMention.findMany).toHaveBeenCalledWith({
      where: { decisionId: { in: ["req-1"] } },
    });
    expect(h.tx.newsMention.updateMany).toHaveBeenCalledWith({
      // Conditional on the stamp — a write since the read makes this match nothing.
      where: { id: "news-1", decisionId: "req-1" },
      data: {
        status: "pending",
        showOnProfile: true,
        enteredByCwid: null,
        decisionId: null,
        decisionAt: null,
        prevStatus: null,
        prevShowOnProfile: null,
        prevEnteredByCwid: null,
      },
    });
    expect(h.appendAuditRow.mock.calls[0][1]).toMatchObject({
      action: "news_mention_update",
      targetEntityType: "news_mention",
      fieldsChanged: ["status", "showOnProfile"],
      beforeValues: { status: "published", showOnProfile: false },
      afterValues: { status: "pending", showOnProfile: true, undoOf: "req-1" },
    });
    expect(h.resolveAffectedProfiles).toHaveBeenCalledWith("scholar", "abc1001", null);
  });

  it("deletes a row the decision created (a reassign) and restores the original", async () => {
    h.tx.newsMention.findMany.mockResolvedValue([
      row({ status: "rejected", showOnProfile: true }),
      row({ id: "news-new", cwid: "zzz9001", prevStatus: null, prevShowOnProfile: null, showOnProfile: true }),
    ]);
    const res = await POST(request({ decisionIds: ["req-1"] }) as never);
    expect(res.status).toBe(200);
    expect(h.tx.newsMention.deleteMany).toHaveBeenCalledWith({
      where: { id: "news-new", decisionId: "req-1" },
    });
    expect(h.tx.newsMention.updateMany).toHaveBeenCalledTimes(1);
    const audits = h.appendAuditRow.mock.calls.map((c) => c[1]);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ fieldsChanged: ["deleted"], afterValues: { deleted: true } });
    const reflected = h.resolveAffectedProfiles.mock.calls.map((c) => c[1]).sort();
    expect(reflected).toEqual(["abc1001", "zzz9001"]);
  });

  it("undoes several decisions in one call (Approve all)", async () => {
    h.tx.newsMention.findMany.mockResolvedValue([row(), row({ id: "news-2", decisionId: "req-2" })]);
    const res = await POST(request({ decisionIds: ["req-1", "req-2", "req-1"] }) as never);
    expect(res.status).toBe(200);
    expect(h.tx.newsMention.findMany).toHaveBeenCalledWith({
      where: { decisionId: { in: ["req-1", "req-2"] } },
    });
    expect(h.tx.newsMention.updateMany).toHaveBeenCalledTimes(2);
  });
});

describe("refusals write nothing", () => {
  it("409s when a decision has nothing left to undo", async () => {
    h.tx.newsMention.findMany.mockResolvedValue([row()]);
    const res = await POST(request({ decisionIds: ["req-1", "req-gone"] }) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "undo_unavailable" });
    expect(h.tx.newsMention.updateMany).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("403s another reviewer's decision", async () => {
    h.tx.newsMention.findMany.mockResolvedValue([row({ enteredByCwid: "oth2002" })]);
    const res = await POST(request({ decisionIds: ["req-1"] }) as never);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_yours" });
    expect(h.tx.newsMention.updateMany).not.toHaveBeenCalled();
  });

  it("409s a decision older than the window", async () => {
    h.tx.newsMention.findMany.mockResolvedValue([
      row({ decisionAt: new Date(Date.now() - 16 * 60 * 1000) }),
    ]);
    const res = await POST(request({ decisionIds: ["req-1"] }) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "undo_expired" });
    expect(h.tx.newsMention.updateMany).not.toHaveBeenCalled();
  });

  it("409s (rolling back) when a row changed between read and write", async () => {
    h.tx.newsMention.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(request({ decisionIds: ["req-1"] }) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "undo_unavailable" });
    expect(h.reflectVisibilityChange).not.toHaveBeenCalled();
  });

  it("400s a bad body", async () => {
    for (const body of [{}, { decisionIds: [] }, { decisionIds: [7] }, { decisionIds: "req-1" }]) {
      const res = await POST(request(body) as never);
      expect(res.status).toBe(400);
    }
    expect(h.tx.newsMention.findMany).not.toHaveBeenCalled();
  });

  it("keeps the steward / superuser gate and the flag", async () => {
    let res = await POST(
      request({ decisionIds: ["req-1"] }, { cwid: "sch1", isSuperuser: false, isCommsSteward: false }) as never,
    );
    expect(res.status).toBe(403);
    process.env.NEWS_APPROVAL_QUEUE = "off";
    res = await POST(request({ decisionIds: ["req-1"] }) as never);
    expect(res.status).toBe(404);
    expect(h.tx.newsMention.findMany).not.toHaveBeenCalled();
  });
});
