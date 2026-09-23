/**
 * `POST /api/edit/news-mention/decision` with `decision: "approve_hidden"` —
 * the news queue's "Approve but hide".
 *
 * It is `approve` in every respect (published, leaves the queue, rejects pending
 * contested siblings, refuses when a sibling already won) plus `showOnProfile`
 * false IN THE SAME WRITE, so the mention never renders on the public profile.
 * It reuses the existing hide rather than a new state, and the existing
 * `news_mention_update` audit action (a new value would 1265 inside the tx).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  reflectVisibilityChange: vi.fn(),
  resolveAffectedProfiles: vi.fn(),
  tx: {
    newsMention: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
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

import { POST } from "@/app/api/edit/news-mention/decision/route";

const PENDING = {
  id: "news-1",
  cwid: "abc1001",
  status: "pending",
  title: "Invented Institute names a new imaging lead",
  detectedName: "Jordan Vale",
  sourceRef: "https://news.example.org/imaging-lead|jordan vale",
  showOnProfile: true,
};

const STEWARD = { cwid: "cms1001", isSuperuser: false, isCommsSteward: true };

function request(body: Record<string, unknown>, session: Record<string, unknown> = STEWARD) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, realCwid: "cms1001", impersonatedCwid: null, body, requestId: "req-1" },
  });
  return new Request("http://x/api/edit/news-mention/decision", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEWS_APPROVAL_QUEUE = "on";
  h.tx.newsMention.findUnique.mockResolvedValue({ ...PENDING });
  h.tx.newsMention.findFirst.mockResolvedValue(null);
  h.tx.newsMention.findMany.mockResolvedValue([]);
  h.tx.newsMention.update.mockImplementation(async ({ where, data }: never) => ({
    ...PENDING,
    ...(where as { id: string }),
    ...(data as object),
  }));
  h.resolveAffectedProfiles.mockImplementation(async (_t: string, cwid: string) => [
    { slug: `slug-${cwid}` },
  ]);
});

describe("approve_hidden", () => {
  it("publishes AND hides in one write, marking the row human-touched", async () => {
    const res = await POST(request({ id: "news-1", decision: "approve_hidden" }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      status: "published",
      showOnProfile: false,
      siblingsRejected: 0,
    });
    expect(h.tx.newsMention.update).toHaveBeenCalledTimes(1);
    expect(h.tx.newsMention.update).toHaveBeenCalledWith({
      where: { id: "news-1" },
      data: { status: "published", showOnProfile: false, enteredByCwid: "cms1001" },
    });
  });

  it("audits as news_mention_update with status + showOnProfile changed", async () => {
    await POST(request({ id: "news-1", decision: "approve_hidden" }) as never);
    expect(h.appendAuditRow).toHaveBeenCalledTimes(1);
    expect(h.appendAuditRow.mock.calls[0][1]).toMatchObject({
      action: "news_mention_update",
      targetEntityType: "news_mention",
      fieldsChanged: ["status", "showOnProfile"],
      beforeValues: expect.objectContaining({ status: "pending", showOnProfile: true }),
      afterValues: expect.objectContaining({ status: "published", showOnProfile: false }),
    });
  });

  it("plain approve still leaves showOnProfile alone", async () => {
    await POST(request({ id: "news-1", decision: "approve" }) as never);
    expect(h.tx.newsMention.update).toHaveBeenCalledWith({
      where: { id: "news-1" },
      data: { status: "published", enteredByCwid: "cms1001" },
    });
    expect(h.appendAuditRow.mock.calls[0][1]).toMatchObject({ fieldsChanged: ["status"] });
  });

  it("rejects pending contested siblings (visible) exactly like approve", async () => {
    h.tx.newsMention.findMany.mockResolvedValue([
      { ...PENDING, id: "news-2", cwid: "def2002" },
    ]);
    const res = await POST(request({ id: "news-1", decision: "approve_hidden" }) as never);
    expect(await res.json()).toMatchObject({ status: "published", siblingsRejected: 1 });
    // The sibling is REJECTED, not hidden — hiding is only this row's editorial call.
    expect(h.tx.newsMention.update).toHaveBeenCalledWith({
      where: { id: "news-2" },
      data: { status: "rejected", enteredByCwid: "cms1001" },
    });
    for (const call of h.appendAuditRow.mock.calls) {
      expect(call[1]).toMatchObject({ action: "news_mention_update" });
    }
    const reflected = h.resolveAffectedProfiles.mock.calls.map((c) => c[1]).sort();
    expect(reflected).toEqual(["abc1001", "def2002"]);
  });

  it("409s and writes nothing when a sibling already won the name", async () => {
    h.tx.newsMention.findFirst.mockResolvedValue({ id: "news-2" });
    const res = await POST(request({ id: "news-1", decision: "approve_hidden" }) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_decided" });
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("is allowed on a rejected row (like approve) but not on a published one", async () => {
    h.tx.newsMention.findUnique.mockResolvedValue({ ...PENDING, status: "rejected" });
    const ok = await POST(request({ id: "news-1", decision: "approve_hidden" }) as never);
    expect(ok.status).toBe(200);

    vi.clearAllMocks();
    h.tx.newsMention.findUnique.mockResolvedValue({ ...PENDING, status: "published" });
    const res = await POST(request({ id: "news-1", decision: "approve_hidden" }) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_pending" });
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
  });

  it("keeps the steward/superuser gate", async () => {
    const res = await POST(
      request(
        { id: "news-1", decision: "approve_hidden" },
        { cwid: "sch1", isSuperuser: false, isCommsSteward: false },
      ) as never,
    );
    expect(res.status).toBe(403);
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
  });

  it("still 400s an unknown decision", async () => {
    const res = await POST(request({ id: "news-1", decision: "hide" }) as never);
    expect(res.status).toBe(400);
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
  });
});
