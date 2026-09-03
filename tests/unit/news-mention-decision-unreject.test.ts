/**
 * `POST /api/edit/news-mention/decision` — un-rejecting (#2578 follow-up).
 *
 * The route now accepts `approve` on an already-`rejected` row, so comms has a
 * "whoops, that WAS the right person" path off the Rejected tab. Nothing in the
 * DB constrains the transition (`status` is a bare ENUM, no CHECK), so the gate
 * lives entirely in the route and this file is the only thing holding it:
 *
 *  1. THE WIDENING IS ONE-WAY. `approve` on `rejected` yes; `reject` on
 *     `rejected` no; `published` undecidable in either direction.
 *  2. APPROVING ONE PERSON NEVER SILENTLY MOVES ANOTHER. If a sibling already
 *     WON the detected name, un-rejecting the loser would have to un-publish the
 *     winner — so it must 409 and write nothing, not cascade.
 *  3. THE AUDIT ACTION STAYS `news_mention_update`. A value absent from the
 *     `scholars_audit` ENUM throws MySQL 1265 inside this transaction and 500s
 *     EVERY decision, while the TS union keeps typecheck and these tests green.
 *     Hence the literal string assertion below — it is the tripwire.
 *
 *  4. THE AUTHZ GATE. This file is the ONLY test of this route in the repo, so
 *     nothing else covers it. Deleting the superuser/comms-steward check left
 *     every other test here green — and the gate is load-bearing: the route
 *     docblock exists because `authorizeOverviewWrite`'s first leg is `self`, so
 *     swapping to it would let a scholar approve a name-match onto their OWN
 *     public profile. Pinned below.
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

/** A CONTESTED row: `sourceRef` is `<url>|<foldedName>`, so the siblings are the
 *  other scholars the same prose name resolved to. */
const REJECTED = {
  id: "news-1",
  cwid: "abc1001",
  status: "rejected",
  title: "Invented Institute names a new imaging lead",
  detectedName: "Jordan Vale",
  sourceRef: "https://news.example.org/imaging-lead|jordan vale",
};

function request(body: Record<string, unknown>, session: Record<string, unknown>) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session,
      realCwid: "cms1001",
      impersonatedCwid: null,
      body,
      requestId: "req-1",
    },
  });
  return new Request("http://x/api/edit/news-mention/decision", { method: "POST" });
}

const STEWARD = { cwid: "cms1001", isSuperuser: false, isCommsSteward: true };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEWS_APPROVAL_QUEUE = "on";
  h.tx.newsMention.findUnique.mockResolvedValue({ ...REJECTED });
  h.tx.newsMention.findFirst.mockResolvedValue(null);
  h.tx.newsMention.findMany.mockResolvedValue([]);
  h.tx.newsMention.update.mockImplementation(async ({ where, data }: never) => ({
    ...REJECTED,
    ...(where as { id: string }),
    ...(data as object),
  }));
  h.resolveAffectedProfiles.mockImplementation(async (_t: string, cwid: string) => [
    { slug: `slug-${cwid}` },
  ]);
});

describe("case 1 — un-rejecting an UNCONTESTED row", () => {
  it("approves a rejected row with no sourceRef and writes status published", async () => {
    // The common "whoops": one scholar, one article, nobody else involved.
    h.tx.newsMention.findUnique.mockResolvedValue({ ...REJECTED, sourceRef: null });
    const res = await POST(request({ id: "news-1", decision: "approve" }, STEWARD) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "published" });
    expect(h.tx.newsMention.update).toHaveBeenCalledWith({
      where: { id: "news-1" },
      // `entered_by_cwid` is what stops etl/news re-proposing the row on the next
      // scrape — the reason un-rejecting is safe at all. Dropping it would let a
      // re-scrape quietly overwrite the reviewer's second thought.
      data: { status: "published", enteredByCwid: "cms1001" },
    });
    // A null sourceRef must never join siblings: MySQL groups all NULLs together.
    expect(h.tx.newsMention.findFirst).not.toHaveBeenCalled();
    expect(h.tx.newsMention.findMany).not.toHaveBeenCalled();
  });

  it("approves a rejected row whose sourceRef nobody else shares", async () => {
    // Still case 1 — the row has a sourceRef because every NAME row does, but the
    // detected name resolved to exactly one scholar.
    const res = await POST(request({ id: "news-1", decision: "approve" }, STEWARD) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "published", siblingsRejected: 0 });
  });
});

describe("case 3 — a sibling already WON the detected name", () => {
  it("🔴 409s and writes NOTHING rather than un-publish the other scholar", async () => {
    // The owner's explicit constraint: approving one person must never silently
    // change a second person's row. Un-publishing the winner is a separate,
    // deliberate decision, so the route refuses instead of cascading.
    h.tx.newsMention.findFirst.mockResolvedValue({ id: "news-2" });
    const res = await POST(request({ id: "news-1", decision: "approve" }, STEWARD) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "already_decided" });
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });
});

describe("case 2 — contested, but nobody is published", () => {
  it("approves and rejects the still-PENDING siblings in the same transaction", async () => {
    h.tx.newsMention.findMany.mockResolvedValue([
      { ...REJECTED, id: "news-2", cwid: "def2002", status: "pending" },
      { ...REJECTED, id: "news-3", cwid: "ghi3003", status: "pending" },
    ]);
    const res = await POST(request({ id: "news-1", decision: "approve" }, STEWARD) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "published", siblingsRejected: 2 });
    expect(h.tx.newsMention.update).toHaveBeenCalledWith({
      where: { id: "news-2" },
      data: { status: "rejected", enteredByCwid: "cms1001" },
    });
    // Only PENDING siblings are swept — an already-rejected one would just get an
    // audit row that says nothing.
    expect(h.tx.newsMention.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "pending" }) }),
    );
  });

  it("reflects every affected owner, not just the un-rejected row's", async () => {
    // The losing siblings belong to DIFFERENT scholars; skipping their reflection
    // leaves their cached profile pages showing a mention just taken away.
    h.tx.newsMention.findMany.mockResolvedValue([
      { ...REJECTED, id: "news-2", cwid: "def2002", status: "pending" },
    ]);
    await POST(request({ id: "news-1", decision: "approve" }, STEWARD) as never);
    const reflected = h.resolveAffectedProfiles.mock.calls.map((c) => c[1]).sort();
    expect(reflected).toEqual(["abc1001", "def2002"]);
  });
});

describe("the widening is one-way", () => {
  it("still refuses to REJECT an already-rejected row", async () => {
    // reject stays pending-only: the row is already there, and a second write
    // would only add a no-op audit row.
    const res = await POST(request({ id: "news-1", decision: "reject" }, STEWARD) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_pending" });
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("still refuses to decide a PUBLISHED row, in either direction", async () => {
    // Un-publishing is the profile card's hide/reject on POST /api/edit/news-mention,
    // not this queue. Letting `reject` through here would take a live mention off a
    // profile from a screen whose whole subject is "is this the right person?".
    h.tx.newsMention.findUnique.mockResolvedValue({ ...REJECTED, status: "published" });
    for (const decision of ["approve", "reject"]) {
      const res = await POST(request({ id: "news-1", decision }, STEWARD) as never);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "not_pending" });
    }
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
  });
});

describe("the audit row", () => {
  it("writes exactly `news_mention_update` — the MySQL 1265 tripwire", async () => {
    // 🔴 If this string ever changes, the new value must first exist in BOTH
    // scholars_audit ENUM sites plus both ALTERs. `appendAuditRow` runs INSIDE the
    // transaction, so an unregistered value throws 1265 and 500s every decision —
    // not just un-rejections. TS-union-only passes typecheck and every test here.
    // EVERY call, not just calls[0]. The sibling-rejection loop writes its own
    // audit rows, and asserting only the primary row left a new action value in
    // that loop completely uncovered — the exact 1265 path, on the contested
    // approvals that ship today rather than only on un-rejections.
    h.tx.newsMention.findMany.mockResolvedValue([
      { id: "news-2", cwid: "sch2", status: "pending", title: "T", detectedName: "A B",
        sourceRef: "u|ab" },
    ]);
    await POST(request({ id: "news-1", decision: "approve" }, STEWARD) as never);
    expect(h.appendAuditRow.mock.calls.length).toBeGreaterThan(1);
    for (const call of h.appendAuditRow.mock.calls) {
      expect(call[1]).toMatchObject({
        action: "news_mention_update",
        targetEntityType: "news_mention",
      });
    }
  });

  it("refuses a non-steward, non-superuser — the gate has no other test", async () => {
    // Deleting the route's 403 block left every other test in this file green.
    // If this route ever moves to `authorizeOverviewWrite`, its `self` leg lets a
    // scholar self-approve a name-match onto their own public profile.
    h.appendAuditRow.mockClear();
    const res = await POST(
      request({ id: "news-1", decision: "approve" }, {
        cwid: "sch1",
        isSuperuser: false,
        isCommsSteward: false,
      }) as never,
    );
    expect(res.status).toBe(403);
    expect(h.appendAuditRow).not.toHaveBeenCalled();
    expect(h.tx.newsMention.update).not.toHaveBeenCalled();
  });

  it("records the rejected -> published transition in before/after", async () => {
    // Without both snapshots the audit log shows an approval with no hint that the
    // row had ever been turned down, which is the one thing a reader of an
    // un-rejection needs to see.
    await POST(request({ id: "news-1", decision: "approve" }, STEWARD) as never);
    expect(h.appendAuditRow.mock.calls[0][1]).toMatchObject({
      beforeValues: expect.objectContaining({ status: "rejected" }),
      afterValues: expect.objectContaining({ status: "published" }),
    });
  });

  it("shares one ts across the un-rejection and its sibling rejections", async () => {
    // `ts` feeds row_hash; a per-row `new Date()` makes N+1 rows read as N+1
    // unrelated edits instead of one decision.
    h.tx.newsMention.findMany.mockResolvedValue([
      { ...REJECTED, id: "news-2", cwid: "def2002", status: "pending" },
    ]);
    await POST(request({ id: "news-1", decision: "approve" }, STEWARD) as never);
    const stamps = h.appendAuditRow.mock.calls.map((c) => (c[1] as { ts: Date }).ts.getTime());
    expect(stamps).toHaveLength(2);
    expect(new Set(stamps).size).toBe(1);
  });
});
