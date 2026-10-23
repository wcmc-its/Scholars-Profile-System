/**
 * `POST /api/edit/grant-attribution/requeue` — #3071. Sends an award the
 * weekly check settled on its own back to the queue.
 *
 * Load-bearing: the same deciders as the decision route; a shown award is
 * hidden again (a queued award is always hidden); the review is written
 * pending WITH the curator as `decidedByCwid`, so the ETL keeps it pending
 * (`isReopenedFromDecision`); an open, decided or age-hidden award is a 409.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isReopenedFromDecision } from "@/etl/reporter-grants/attribution-plan";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  reflectVisibilityChange: vi.fn(),
  resolveAffectedProfiles: vi.fn(),
  reflectGrantSuppressions: vi.fn(),
  runAfterResponse: vi.fn(),
  tx: {
    grantAttributionScore: { findUnique: vi.fn() },
    grantAttributionReview: { findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    suppression: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
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

import { POST } from "@/app/api/edit/grant-attribution/requeue/route";

const ENTITY = "reporter:t000001:R01XX000001";
const SCORE = {
  grantExternalId: ENTITY,
  cwid: "t000001",
  band: "show",
  score: 3,
  cues: [{ id: "profile_proven", weight: 3, reason: "proven" }],
  evidenceKey: "show|profile_proven",
  award: { title: "A synthetic study" },
  reporterName: "EXAMPLE, PAT",
  scoredAt: new Date("2026-10-23T14:00:00Z"),
};

function request(
  body: Record<string, unknown>,
  session: Record<string, unknown>,
  impersonatedCwid: string | null = null,
) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, realCwid: "c000001", impersonatedCwid, body, requestId: "req-1" },
  });
  return new Request("http://x/api/edit/grant-attribution/requeue", { method: "POST" }) as never;
}

const STEWARD = { cwid: "c000001", isSuperuser: false, isCommsSteward: true };
const OBSERVER = { cwid: "c000001", isSuperuser: false, isCommsSteward: true, isObserver: true };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GRANT_ATTRIBUTION_QUEUE = "on";
  h.tx.grantAttributionScore.findUnique.mockResolvedValue({ ...SCORE });
  h.tx.grantAttributionReview.findUnique.mockResolvedValue(null);
  h.tx.grantAttributionReview.updateMany.mockResolvedValue({ count: 1 });
  h.tx.grantAttributionReview.create.mockResolvedValue({});
  h.tx.suppression.findMany.mockResolvedValue([]);
  h.tx.suppression.findFirst.mockResolvedValue(null);
  h.tx.suppression.create.mockResolvedValue({ id: "sup-new" });
  h.resolveAffectedProfiles.mockResolvedValue([{ slug: "slug-a", cwid: "t000001" }]);
});

describe("requeue", () => {
  it("404s when the flag is off, before any authz", async () => {
    process.env.GRANT_ATTRIBUTION_QUEUE = "off";
    expect((await POST(request({ id: ENTITY }, STEWARD))).status).toBe(404);
    expect(h.readEditRequest).not.toHaveBeenCalled();
  });

  it("403s a read-only role and a View-as superuser", async () => {
    expect((await POST(request({ id: ENTITY }, OBSERVER))).status).toBe(403);
    expect(
      (await POST(request({ id: ENTITY }, { cwid: "c000001", isSuperuser: true }, "t000009")))
        .status,
    ).toBe(403);
    expect(h.tx.suppression.create).not.toHaveBeenCalled();
  });

  it("hides a shown award again and opens a review the ETL will keep pending", async () => {
    const res = await POST(request({ id: ENTITY }, STEWARD));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "pending", hidden: true });
    expect(h.tx.suppression.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "grant",
        entityId: ENTITY,
        createdBy: "system-unverified",
      }),
    });
    const data = h.tx.grantAttributionReview.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      cwid: "t000001",
      grantExternalId: ENTITY,
      status: "pending",
      decidedByCwid: "c000001",
      band: "show",
    });
    expect(isReopenedFromDecision({ status: data.status, decidedByCwid: data.decidedByCwid })).toBe(
      true,
    );
    expect(h.appendAuditRow.mock.calls[0]![1]).toMatchObject({
      action: "grant_attribution_requeue",
      targetEntityId: ENTITY,
    });
    expect(h.reflectVisibilityChange).toHaveBeenCalledWith(["slug-a"]);
  });

  it("keeps a hidden award's own hide and reopens its withdrawn review", async () => {
    h.tx.grantAttributionScore.findUnique.mockResolvedValue({ ...SCORE, band: "hide" });
    h.tx.suppression.findMany.mockResolvedValue([{ createdBy: "system-unverified" }]);
    h.tx.grantAttributionReview.findUnique.mockResolvedValue({ id: "rev-1", status: "withdrawn" });
    const res = await POST(request({ id: ENTITY }, STEWARD));
    expect(await res.json()).toMatchObject({ hidden: false });
    expect(h.tx.suppression.create).not.toHaveBeenCalled();
    expect(h.tx.grantAttributionReview.updateMany).toHaveBeenCalledWith({
      where: { id: "rev-1", status: "withdrawn" },
      data: expect.objectContaining({ status: "pending", decidedByCwid: "c000001" }),
    });
    expect(h.reflectVisibilityChange).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an unscored award",
      () => h.tx.grantAttributionScore.findUnique.mockResolvedValue(null),
      404,
      "not_found",
    ],
    [
      "one already in review",
      () =>
        h.tx.grantAttributionReview.findUnique.mockResolvedValue({ id: "r", status: "pending" }),
      409,
      "already_pending",
    ],
    [
      "one a curator decided",
      () =>
        h.tx.grantAttributionReview.findUnique.mockResolvedValue({ id: "r", status: "confirmed" }),
      409,
      "decided",
    ],
    [
      "one the age rule ever hid",
      () => h.tx.suppression.findFirst.mockResolvedValue({ id: "sup-age" }),
      409,
      "hidden_by_age",
    ],
  ])("refuses %s and writes nothing", async (_l, arrange, status, code) => {
    arrange();
    const res = await POST(request({ id: ENTITY }, STEWARD));
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: code });
    expect(h.tx.suppression.create).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("409s when the withdrawn review moved on meanwhile", async () => {
    h.tx.grantAttributionReview.findUnique.mockResolvedValue({ id: "rev-1", status: "withdrawn" });
    h.tx.grantAttributionReview.updateMany.mockResolvedValue({ count: 0 });
    expect((await POST(request({ id: ENTITY }, STEWARD))).status).toBe(409);
  });
});
