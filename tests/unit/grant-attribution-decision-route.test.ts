/**
 * `POST /api/edit/grant-attribution/decision` — #3071.
 *
 * Load-bearing and enforced nowhere else: who may decide, that "Not this
 * person" is a CURATOR-owned suppression (the ETL ignores it), that confirm
 * lifts exactly the hides it should, that undo reverses exactly one decision,
 * and that a race or a stale item is a 409, not a second write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  reflectVisibilityChange: vi.fn(),
  resolveAffectedProfiles: vi.fn(),
  reflectGrantSuppressions: vi.fn(),
  runAfterResponse: vi.fn(),
  tx: {
    grantAttributionReview: { findUnique: vi.fn(), updateMany: vi.fn() },
    suppression: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
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
vi.mock("@/lib/edit/search-suppression", () => ({
  reflectGrantSuppressions: h.reflectGrantSuppressions,
}));
vi.mock("@/lib/edit/after-response", () => ({ runAfterResponse: h.runAfterResponse }));
vi.mock("@/lib/db", () => ({
  db: { write: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(h.tx)) } },
}));

import { POST } from "@/app/api/edit/grant-attribution/decision/route";
import { NOT_THIS_PERSON_REASON_PREFIX } from "@/lib/edit/grant-attribution-queue";

const ENTITY = "reporter:t000001:R01XX000001";
const PENDING = {
  id: "rev-1",
  cwid: "t000001",
  grantExternalId: ENTITY,
  status: "pending",
  score: 0,
  band: "queue",
  decidedAt: null,
  decisionEffects: null,
};
const SYSTEM_HIDE = { id: "sup-sys", createdBy: "system-unverified", reason: "RePORTER grant hidden pending curator review" };

function request(
  body: Record<string, unknown>,
  session: Record<string, unknown>,
  impersonatedCwid: string | null = null,
) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, realCwid: "c000001", impersonatedCwid, body, requestId: "req-1" },
  });
  return new Request("http://x/api/edit/grant-attribution/decision", { method: "POST" }) as never;
}

const SUPERUSER = { cwid: "c000001", isSuperuser: true };
const STEWARD = { cwid: "c000001", isSuperuser: false, isCommsSteward: true };
const OBSERVER = { cwid: "c000001", isSuperuser: false, isObserver: true };
const CONTENT_EDITOR = { cwid: "c000001", isSuperuser: false, isContentEditor: true };
const SELF = { cwid: "t000001", isSuperuser: false };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GRANT_ATTRIBUTION_QUEUE = "on";
  h.tx.grantAttributionReview.findUnique.mockResolvedValue({ ...PENDING });
  h.tx.grantAttributionReview.updateMany.mockResolvedValue({ count: 1 });
  h.tx.suppression.findMany.mockResolvedValue([{ ...SYSTEM_HIDE }]);
  h.tx.suppression.updateMany.mockResolvedValue({ count: 1 });
  h.tx.suppression.create.mockResolvedValue({ id: "sup-cur" });
  h.resolveAffectedProfiles.mockResolvedValue([{ slug: "slug-a", cwid: "t000001" }]);
});

describe("authorization", () => {
  it("404s for everyone when the flag is off, before any authz", async () => {
    process.env.GRANT_ATTRIBUTION_QUEUE = "off";
    const res = await POST(request({ id: "rev-1", decision: "confirm" }, SUPERUSER));
    expect(res.status).toBe(404);
    expect(h.readEditRequest).not.toHaveBeenCalled();
  });

  it("admits a superuser and a comms_steward", async () => {
    expect((await POST(request({ id: "rev-1", decision: "confirm" }, SUPERUSER))).status).toBe(200);
    expect((await POST(request({ id: "rev-1", decision: "confirm" }, STEWARD))).status).toBe(200);
  });

  it.each([
    ["an observer (read-only)", OBSERVER],
    ["a content editor (read-only)", CONTENT_EDITOR],
    ["the scholar themselves", SELF],
  ])("403s %s and writes nothing", async (_label, session) => {
    const res = await POST(request({ id: "rev-1", decision: "confirm" }, session));
    expect(res.status).toBe(403);
    expect(h.tx.suppression.updateMany).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("refuses a superuser acting under View as", async () => {
    const res = await POST(request({ id: "rev-1", decision: "confirm" }, SUPERUSER, "t000009"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "impersonation_refused" });
  });
});

describe("validation", () => {
  it("rejects an unknown decision, a reason on confirm, and an over-long reason", async () => {
    expect((await POST(request({ id: "rev-1", decision: "approve" }, SUPERUSER))).status).toBe(400);
    expect((await POST(request({ id: "rev-1", decision: "confirm", reason: "x" }, SUPERUSER))).status).toBe(400);
    const long = "x".repeat(256);
    expect((await POST(request({ id: "rev-1", decision: "reject", reason: long }, SUPERUSER))).status).toBe(400);
  });

  it("requires a reason to reject, one or many", async () => {
    expect((await POST(request({ id: "rev-1", decision: "reject" }, SUPERUSER))).status).toBe(400);
    expect((await POST(request({ id: "rev-1", decision: "reject", reason: "   " }, SUPERUSER))).status).toBe(400);
    expect((await POST(request({ ids: ["a", "b"], decision: "reject" }, SUPERUSER))).status).toBe(400);
  });

  it("caps a bulk decision and refuses duplicates", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `rev-${i}`);
    expect((await POST(request({ ids: many, decision: "confirm" }, SUPERUSER))).status).toBe(400);
    expect((await POST(request({ ids: ["a", "a"], decision: "confirm" }, SUPERUSER))).status).toBe(400);
  });
});

describe("confirm", () => {
  it("revokes the system hide as the real actor, claims the review, audits, reflects", async () => {
    const res = await POST(request({ id: "rev-1", decision: "confirm" }, STEWARD));
    expect(res.status).toBe(200);
    expect(h.tx.suppression.updateMany).toHaveBeenCalledWith({
      where: { id: "sup-sys", revokedAt: null },
      data: expect.objectContaining({ revokedBy: "c000001", searchReflectedAt: null }),
    });
    expect(h.tx.grantAttributionReview.updateMany).toHaveBeenCalledWith({
      where: { id: "rev-1", status: "pending" },
      data: expect.objectContaining({
        status: "confirmed",
        decidedByCwid: "c000001",
        decisionEffects: { revoked: ["sup-sys"], created: [] },
      }),
    });
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        action: "grant_attribution_confirm",
        targetEntityType: "grant",
        targetEntityId: ENTITY,
        actorCwid: "c000001",
      }),
    );
    expect(h.resolveAffectedProfiles).toHaveBeenCalledWith("grant", ENTITY, null);
    expect(h.reflectVisibilityChange).toHaveBeenCalledWith(["slug-a"]);
    expect(h.runAfterResponse).toHaveBeenCalledTimes(1);
  });

  it("409s when the award is also hidden by age (confirm would not show it)", async () => {
    h.tx.suppression.findMany.mockResolvedValue([
      { ...SYSTEM_HIDE },
      { id: "sup-age", createdBy: "system-recency", reason: "by age" },
    ]);
    const res = await POST(request({ id: "rev-1", decision: "confirm" }, SUPERUSER));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "hidden_by_age" });
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("409s on an already-decided item, and when another curator wins the race", async () => {
    h.tx.grantAttributionReview.findUnique.mockResolvedValueOnce({ ...PENDING, status: "rejected" });
    expect((await POST(request({ id: "rev-1", decision: "confirm" }, SUPERUSER))).status).toBe(409);
    h.tx.grantAttributionReview.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(request({ id: "rev-1", decision: "confirm" }, SUPERUSER));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_pending" });
  });

  it("404s an unknown item", async () => {
    h.tx.grantAttributionReview.findUnique.mockResolvedValueOnce(null);
    expect((await POST(request({ id: "nope", decision: "confirm" }, SUPERUSER))).status).toBe(404);
  });
});

describe("reject (Not this person)", () => {
  it("adds a CURATOR-owned suppression and leaves the system hide in place", async () => {
    const res = await POST(request({ id: "rev-1", decision: "reject", reason: "Different person" }, SUPERUSER));
    expect(res.status).toBe(200);
    expect(h.tx.suppression.create).toHaveBeenCalledWith({
      data: {
        entityType: "grant",
        entityId: ENTITY,
        reason: `${NOT_THIS_PERSON_REASON_PREFIX}: Different person`,
        createdBy: "c000001",
      },
    });
    expect(h.tx.suppression.updateMany).not.toHaveBeenCalled();
    expect(h.tx.grantAttributionReview.updateMany).toHaveBeenCalledWith({
      where: { id: "rev-1", status: "pending" },
      data: expect.objectContaining({
        status: "rejected",
        rejectionReason: "Different person",
        decisionEffects: { revoked: [], created: ["sup-cur"] },
      }),
    });
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ action: "grant_attribution_reject" }),
    );
  });
});

describe("undo", () => {
  it("restores the revoked system hide and reopens the review", async () => {
    h.tx.grantAttributionReview.findUnique.mockResolvedValue({
      ...PENDING,
      status: "confirmed",
      decidedAt: new Date("2026-10-19T00:00:00Z"),
      decisionEffects: { revoked: ["sup-sys"], created: [] },
    });
    const res = await POST(request({ id: "rev-1", decision: "undo" }, SUPERUSER));
    expect(res.status).toBe(200);
    expect(h.tx.suppression.updateMany).toHaveBeenCalledWith({
      where: { id: "sup-sys", entityId: ENTITY, revokedAt: { not: null } },
      data: { revokedAt: null, revokedBy: null, searchReflectedAt: null },
    });
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ action: "grant_attribution_undo" }),
    );
  });

  it("revokes the curator hide a rejection created", async () => {
    h.tx.grantAttributionReview.findUnique.mockResolvedValue({
      ...PENDING,
      status: "rejected",
      decidedAt: new Date("2026-10-19T00:00:00Z"),
      decisionEffects: { revoked: [], created: ["sup-cur"] },
    });
    expect((await POST(request({ id: "rev-1", decision: "undo" }, SUPERUSER))).status).toBe(200);
    expect(h.tx.suppression.updateMany).toHaveBeenCalledWith({
      where: { id: "sup-cur", entityId: ENTITY, revokedAt: null },
      data: expect.objectContaining({ revokedBy: "c000001" }),
    });
  });

  it("refuses an item the queue never decided (pending, or withdrawn by the ETL)", async () => {
    expect((await POST(request({ id: "rev-1", decision: "undo" }, SUPERUSER))).status).toBe(409);
    h.tx.grantAttributionReview.findUnique.mockResolvedValue({
      ...PENDING,
      status: "withdrawn",
      decidedAt: new Date(),
      decisionEffects: null,
    });
    expect((await POST(request({ id: "rev-1", decision: "undo" }, SUPERUSER))).status).toBe(409);
  });

  it("409s, writing no audit row, when the hide it would restore has changed", async () => {
    h.tx.grantAttributionReview.findUnique.mockResolvedValue({
      ...PENDING,
      status: "confirmed",
      decidedAt: new Date(),
      decisionEffects: { revoked: ["sup-sys"], created: [] },
    });
    h.tx.suppression.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(request({ id: "rev-1", decision: "undo" }, SUPERUSER));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "state_changed" });
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });
});

describe("bulk is all-or-nothing", () => {
  it("one refusal fails the whole request", async () => {
    h.tx.grantAttributionReview.findUnique
      .mockResolvedValueOnce({ ...PENDING })
      .mockResolvedValueOnce({ ...PENDING, id: "rev-2", status: "confirmed" });
    const res = await POST(request({ ids: ["rev-1", "rev-2"], decision: "confirm" }, SUPERUSER));
    expect(res.status).toBe(409);
    // The transaction threw, so nothing reflects.
    expect(h.reflectVisibilityChange).not.toHaveBeenCalled();
  });
});
