/**
 * `POST /api/edit/honor/decision` — #1762.
 *
 * Four behaviours here are load-bearing and none of them is enforced by the
 * schema, so this file is the only thing standing behind them:
 *
 *  1. AUTHZ. A non-superuser `honors_curator` must get in (the Research Dean's
 *     office self-serves), and everyone else must not.
 *  2. A LINE IS AWARDED ONCE. Approving a row whose sibling is already published
 *     credits two people with one fellowship.
 *  3. THE APPROVED HONOR MUST ACTUALLY APPEAR. The profile page is cached; skip
 *     the reflection and the write succeeds while the page does not change.
 *  4. ONE DECISION, ONE TIMESTAMP. The N+1 audit rows are only legible as a single
 *     decision if they share a `ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  reflectVisibilityChange: vi.fn(),
  resolveAffectedProfiles: vi.fn(),
  tx: {
    honor: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
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

import { POST } from "@/app/api/edit/honor/decision/route";

const ROW = {
  id: "honor-1",
  cwid: "abc1001",
  status: "pending",
  name: "Sloan Research Fellowship",
  organization: "Sloan Foundation",
  year: 2013,
  sourceRef: "https://sloan.org/fellows#line-42",
};

function request(body: Record<string, unknown>, session: Record<string, unknown>) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session,
      realCwid: "cur1001",
      impersonatedCwid: null,
      body,
      requestId: "req-1",
    },
  });
  return new Request("http://x/api/edit/honor/decision", { method: "POST" });
}

const SUPERUSER = { cwid: "cur1001", isSuperuser: true, isHonorsCurator: false };
const CURATOR = { cwid: "cur1001", isSuperuser: false, isHonorsCurator: true };
const NOBODY = { cwid: "joe1001", isSuperuser: false, isHonorsCurator: false };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.HONORS_APPROVAL_QUEUE = "on";
  h.tx.honor.findUnique.mockResolvedValue({ ...ROW });
  h.tx.honor.findFirst.mockResolvedValue(null);
  h.tx.honor.findMany.mockResolvedValue([]);
  h.tx.honor.update.mockImplementation(async ({ where, data }: never) => ({
    ...ROW,
    ...(where as { id: string }),
    ...(data as object),
  }));
  h.tx.honor.updateMany.mockResolvedValue({ count: 1 });
  h.resolveAffectedProfiles.mockImplementation(async (_t: string, cwid: string) => [
    { slug: `slug-${cwid}` },
  ]);
});

describe("authorization", () => {
  it("admits a NON-superuser honors_curator", async () => {
    // The role's entire purpose. If this 403s, the Research Dean's office cannot
    // work the queue and the queue has no users.
    const res = await POST(request({ id: "honor-1", decision: "approve" }, CURATOR) as never);
    expect(res.status).toBe(200);
  });

  it("admits a superuser who is not in the curator group", async () => {
    const res = await POST(request({ id: "honor-1", decision: "approve" }, SUPERUSER) as never);
    expect(res.status).toBe(200);
  });

  it("403s a signed-in scholar who is neither", async () => {
    const res = await POST(request({ id: "honor-1", decision: "approve" }, NOBODY) as never);
    expect(res.status).toBe(403);
    expect(h.tx.honor.update).not.toHaveBeenCalled();
  });

  it("404s for everyone when the flag is off, before any authz", async () => {
    process.env.HONORS_APPROVAL_QUEUE = "off";
    const res = await POST(request({ id: "honor-1", decision: "approve" }, SUPERUSER) as never);
    expect(res.status).toBe(404);
  });
});

describe("a roster line is awarded at most once", () => {
  it("🔴 409s rather than approve a row whose sibling is already published", async () => {
    // THE failure this queue exists to prevent: two people credited with one
    // fellowship. Nothing in the DB stops it — `status` is a bare ENUM with no
    // CHECK — and the Phase 2 seed is written out of band, so the guard is real.
    h.tx.honor.findFirst.mockResolvedValue({ id: "honor-2" });
    const res = await POST(request({ id: "honor-1", decision: "approve" }, SUPERUSER) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "line_already_awarded" });
    expect(h.tx.honor.update).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("409s on a row that is already decided — `rejected` is terminal", async () => {
    // Terminality is asserted by the migration and enforced by NOTHING in the DB:
    // rejected -> published is a legal transition there. This guard IS the rule.
    h.tx.honor.findUnique.mockResolvedValue({ ...ROW, status: "rejected" });
    const res = await POST(request({ id: "honor-1", decision: "approve" }, SUPERUSER) as never);
    expect(res.status).toBe(409);
    expect(h.tx.honor.update).not.toHaveBeenCalled();
  });

  it("rejects the siblings of an approved row, in the same transaction", async () => {
    h.tx.honor.findMany.mockResolvedValue([
      { ...ROW, id: "honor-2", cwid: "def2002" },
      { ...ROW, id: "honor-3", cwid: "ghi3003" },
    ]);
    const res = await POST(request({ id: "honor-1", decision: "approve" }, SUPERUSER) as never);
    expect(await res.json()).toMatchObject({ siblingsRejected: 2 });
    expect(h.tx.honor.update).toHaveBeenCalledWith({
      where: { id: "honor-2" },
      data: expect.objectContaining({ status: "rejected", supersededById: "honor-1" }),
    });
    // Only PENDING siblings are touched: an already-rejected one is terminal and
    // re-writing it would emit an audit row that says nothing.
    expect(h.tx.honor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "pending" }) }),
    );
  });

  it("does NOT fan out on reject — the other candidates stay live questions", async () => {
    h.tx.honor.findMany.mockResolvedValue([{ ...ROW, id: "honor-2", cwid: "def2002" }]);
    const res = await POST(request({ id: "honor-1", decision: "reject" }, SUPERUSER) as never);
    expect(res.status).toBe(200);
    expect(h.tx.honor.update).toHaveBeenCalledTimes(1);
  });

  it("never joins siblings on a NULL sourceRef", async () => {
    // MySQL groups all NULLs together; a hand-entered row has sourceRef NULL by
    // design. Joining on it would mark every unrelated hand-entered honor a
    // competing candidate.
    h.tx.honor.findUnique.mockResolvedValue({ ...ROW, sourceRef: null });
    await POST(request({ id: "honor-1", decision: "approve" }, SUPERUSER) as never);
    expect(h.tx.honor.findMany).not.toHaveBeenCalled();
    expect(h.tx.honor.findFirst).not.toHaveBeenCalled();
  });
});

describe("the approved honor actually appears", () => {
  it("reflects EVERY affected owner, not just the approved row's", async () => {
    // Siblings belong to DIFFERENT scholars — that is what makes them competing
    // candidates. Reflecting only the winner leaves the losers' cached pages
    // showing an honor that was just rejected.
    h.tx.honor.findMany.mockResolvedValue([{ ...ROW, id: "honor-2", cwid: "def2002" }]);
    await POST(request({ id: "honor-1", decision: "approve" }, SUPERUSER) as never);
    const reflected = h.resolveAffectedProfiles.mock.calls.map((c) => c[1]).sort();
    expect(reflected).toEqual(["abc1001", "def2002"]);
  });

  it("still returns 200 when reflection fails — the decision is already committed", async () => {
    // A post-commit failure cannot roll the write back, so it must not present as
    // a failed decision (the curator would re-click and 409).
    h.resolveAffectedProfiles.mockRejectedValue(new Error("revalidate exploded"));
    const res = await POST(request({ id: "honor-1", decision: "approve" }, SUPERUSER) as never);
    expect(res.status).toBe(200);
  });

  it("one owner's reflection failure does not abort the others", async () => {
    h.tx.honor.findMany.mockResolvedValue([{ ...ROW, id: "honor-2", cwid: "def2002" }]);
    h.resolveAffectedProfiles.mockImplementation(async (_t: string, cwid: string) => {
      if (cwid === "abc1001") throw new Error("boom");
      return [{ slug: `slug-${cwid}` }];
    });
    await POST(request({ id: "honor-1", decision: "approve" }, SUPERUSER) as never);
    expect(h.reflectVisibilityChange).toHaveBeenCalledWith(["slug-def2002"]);
  });
});

describe("one decision, one timestamp", () => {
  it("shares a single ts across every audit row the decision writes", async () => {
    // `ts` feeds row_hash, and a per-row `new Date()` makes N+1 rows read as N+1
    // unrelated edits rather than one approval. The plain honor route stamps per
    // row because it has no batch; core-claim/bulk hoists. This is a batch.
    h.tx.honor.findMany.mockResolvedValue([
      { ...ROW, id: "honor-2", cwid: "def2002" },
      { ...ROW, id: "honor-3", cwid: "ghi3003" },
    ]);
    await POST(request({ id: "honor-1", decision: "approve" }, SUPERUSER) as never);
    const stamps = h.appendAuditRow.mock.calls.map((c) => (c[1] as { ts: Date }).ts.getTime());
    expect(stamps).toHaveLength(3);
    expect(new Set(stamps).size).toBe(1);
  });

  it("threads one requestId across the whole decision", async () => {
    h.tx.honor.findMany.mockResolvedValue([{ ...ROW, id: "honor-2", cwid: "def2002" }]);
    await POST(request({ id: "honor-1", decision: "approve" }, SUPERUSER) as never);
    const ids = h.appendAuditRow.mock.calls.map((c) => (c[1] as { requestId: string }).requestId);
    expect(new Set(ids)).toEqual(new Set(["req-1"]));
  });

  it("records the status transition on an action already in the SQL ENUM", async () => {
    // Deliberately honor_update, not a new honor_approve: a value absent from the
    // scholars_audit ENUM throws inside the transaction and 500s 100% of writes
    // while the TS union keeps tests green.
    await POST(request({ id: "honor-1", decision: "approve" }, SUPERUSER) as never);
    expect(h.appendAuditRow.mock.calls[0][1]).toMatchObject({
      action: "honor_update",
      fieldsChanged: ["status", "decidedByCwid", "decidedAt"],
      targetEntityType: "honor",
      beforeValues: expect.objectContaining({ status: "pending" }),
      afterValues: expect.objectContaining({ status: "published" }),
    });
  });
});

describe("decision metadata", () => {
  it("stamps the REAL actor and the decision's one ts on the decided row", async () => {
    await POST(request({ id: "honor-1", decision: "approve" }, CURATOR) as never);
    const data = h.tx.honor.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: "published",
      decidedByCwid: "cur1001",
      rejectionReason: null,
      supersededById: null,
    });
    expect(data.decidedAt).toBeInstanceOf(Date);
    expect(data.decidedAt).toEqual(h.appendAuditRow.mock.calls[0][1].ts);
  });

  it("stores a trimmed rejection reason and lists it in fieldsChanged", async () => {
    const res = await POST(
      request(
        { id: "honor-1", decision: "reject", reason: "  Different person " },
        CURATOR,
      ) as never,
    );
    expect(res.status).toBe(200);
    expect(h.tx.honor.update.mock.calls[0][0].data).toMatchObject({
      status: "rejected",
      rejectionReason: "Different person",
    });
    expect(h.appendAuditRow.mock.calls[0][1].fieldsChanged).toContain("rejectionReason");
  });

  it("a blank reason stores NULL", async () => {
    await POST(request({ id: "honor-1", decision: "reject", reason: "   " }, CURATOR) as never);
    expect(h.tx.honor.update.mock.calls[0][0].data.rejectionReason).toBeNull();
  });

  it("400s an over-long reason rather than truncating it", async () => {
    const res = await POST(
      request({ id: "honor-1", decision: "reject", reason: "x".repeat(256) }, CURATOR) as never,
    );
    expect(res.status).toBe(400);
    expect(h.tx.honor.update).not.toHaveBeenCalled();
  });

  it("400s a reason on an approve", async () => {
    const res = await POST(
      request({ id: "honor-1", decision: "approve", reason: "Different person" }, CURATOR) as never,
    );
    expect(res.status).toBe(400);
  });
});

describe("undo", () => {
  const DECIDED_AT = new Date("2026-09-20T12:00:00Z");

  it("🔴 refuses a published row the queue never decided (it would vanish from a profile)", async () => {
    // A hand-entered or self-asserted honor is `published` with no decidedAt.
    // Knocking it back to pending would hide it on the public page.
    h.tx.honor.findUnique.mockResolvedValue({ ...ROW, status: "published", decidedAt: null });
    const res = await POST(request({ id: "honor-1", decision: "undo" }, CURATOR) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_undoable" });
    expect(h.tx.honor.updateMany).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("refuses a row that is still pending", async () => {
    const res = await POST(request({ id: "honor-1", decision: "undo" }, CURATOR) as never);
    expect(res.status).toBe(409);
    expect(h.tx.honor.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an auto-rejected sibling on its own; the approval is what gets undone", async () => {
    h.tx.honor.findUnique.mockResolvedValue({
      ...ROW,
      status: "rejected",
      decidedAt: DECIDED_AT,
      supersededById: "honor-9",
    });
    const res = await POST(request({ id: "honor-1", decision: "undo" }, CURATOR) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "superseded" });
    expect(h.tx.honor.updateMany).not.toHaveBeenCalled();
  });

  it("reverts a rejection to pending and clears the decision columns", async () => {
    h.tx.honor.findUnique.mockResolvedValue({
      ...ROW,
      status: "rejected",
      decidedAt: DECIDED_AT,
      decidedByCwid: "cur1001",
      rejectionReason: "Name collision",
    });
    const res = await POST(request({ id: "honor-1", decision: "undo" }, CURATOR) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "pending", siblingsRestored: 0 });
    expect(h.tx.honor.updateMany).toHaveBeenCalledWith({
      where: { id: "honor-1", status: "rejected", decidedAt: { not: null }, supersededById: null },
      data: {
        status: "pending",
        decidedByCwid: null,
        decidedAt: null,
        rejectionReason: null,
        supersededById: null,
      },
    });
    // Undoing a rejection never touches siblings (it only checks none has won).
    expect(h.tx.honor.findMany).not.toHaveBeenCalled();
    expect(h.tx.honor.findFirst).toHaveBeenCalledWith({
      where: { sourceRef: ROW.sourceRef, status: "published", id: { notIn: ["honor-1"] } },
      select: { id: true },
    });
    expect(h.appendAuditRow.mock.calls[0][1]).toMatchObject({
      action: "honor_update",
      targetEntityId: "honor-1",
      beforeValues: expect.objectContaining({
        status: "rejected",
        rejectionReason: "Name collision",
      }),
      afterValues: expect.objectContaining({ status: "pending", rejectionReason: null }),
    });
  });

  it("undoing an approval restores exactly the siblings it auto-rejected, audited under one ts", async () => {
    h.tx.honor.findUnique.mockResolvedValue({
      ...ROW,
      status: "published",
      decidedAt: DECIDED_AT,
      decidedByCwid: "cur1001",
    });
    h.tx.honor.findMany.mockResolvedValue([
      { ...ROW, id: "honor-2", cwid: "def2002", status: "rejected", supersededById: "honor-1" },
    ]);
    const res = await POST(request({ id: "honor-1", decision: "undo" }, CURATOR) as never);
    expect(await res.json()).toMatchObject({ ok: true, siblingsRestored: 1 });
    expect(h.tx.honor.findMany).toHaveBeenCalledWith({
      where: { supersededById: "honor-1", status: "rejected" },
    });
    expect(h.tx.honor.updateMany).toHaveBeenCalledWith({
      where: { id: "honor-2", status: "rejected", supersededById: "honor-1" },
      data: expect.objectContaining({ status: "pending", supersededById: null }),
    });
    const audits = h.appendAuditRow.mock.calls.map(
      (c) => c[1] as { targetEntityId: string; ts: Date },
    );
    expect(audits.map((a) => a.targetEntityId)).toEqual(["honor-1", "honor-2"]);
    expect(new Set(audits.map((a) => a.ts.getTime())).size).toBe(1);
    // Both owners' cached profiles change: the winner loses the honor.
    const reflected = h.resolveAffectedProfiles.mock.calls.map((c) => c[1]).sort();
    expect(reflected).toEqual(["abc1001", "def2002"]);
  });

  it("🔴 refuses to reopen a MANUAL rejection once another candidate on the line is approved", async () => {
    // Reject A, approve B (B's approval only auto-rejects PENDING siblings, so A
    // carries no supersededById), then undo A: A would sit pending next to a
    // published winner — a second live claim on an awarded line.
    h.tx.honor.findUnique.mockResolvedValue({
      ...ROW,
      status: "rejected",
      decidedAt: DECIDED_AT,
      supersededById: null,
    });
    h.tx.honor.findFirst.mockResolvedValue({ id: "honor-2" });
    const res = await POST(request({ id: "honor-1", decision: "undo" }, CURATOR) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "line_already_awarded" });
    expect(h.tx.honor.updateMany).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
  });

  it("🔴 a concurrent undo that already moved the row loses: 409, no audit row", async () => {
    // Both undos read the row as decided; the conditional updateMany is what
    // lets only one of them transition it.
    h.tx.honor.findUnique.mockResolvedValue({ ...ROW, status: "rejected", decidedAt: DECIDED_AT });
    h.tx.honor.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(request({ id: "honor-1", decision: "undo" }, CURATOR) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_undoable" });
    expect(h.appendAuditRow).not.toHaveBeenCalled();
    expect(h.resolveAffectedProfiles).not.toHaveBeenCalled();
  });

  it("🔴 a multi-row undo is all-or-nothing: a later refusal throws so the transaction rolls back", async () => {
    // "None of these" wrote c1 and c2. If c2 cannot be undone, c1's revert must
    // not commit — the throw is what makes Prisma roll the transaction back.
    const rows: Record<string, unknown> = {
      c1: { ...ROW, id: "c1", status: "rejected", decidedAt: DECIDED_AT },
      c2: { ...ROW, id: "c2", status: "rejected", decidedAt: DECIDED_AT, supersededById: "x" },
    };
    h.tx.honor.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => rows[where.id] ?? null,
    );
    const { db } = await import("@/lib/db");
    const txn = vi.mocked(db.write.$transaction);
    const res = await POST(request({ ids: ["c1", "c2"], decision: "undo" }, CURATOR) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "superseded" });
    // The callback REJECTED (not resolved with a refusal value), so a real
    // interactive transaction discards c1's already-issued update.
    await expect(txn.mock.results[0].value).rejects.toThrow("superseded");
    expect(h.resolveAffectedProfiles).not.toHaveBeenCalled();
  });

  it("undoes every row of a multi-row rejection in one transaction", async () => {
    const rows: Record<string, unknown> = {
      c1: { ...ROW, id: "c1", cwid: "abc1001", status: "rejected", decidedAt: DECIDED_AT },
      c2: { ...ROW, id: "c2", cwid: "def2002", status: "rejected", decidedAt: DECIDED_AT },
    };
    h.tx.honor.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => rows[where.id] ?? null,
    );
    const res = await POST(request({ ids: ["c1", "c2"], decision: "undo" }, CURATOR) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "pending", reverted: 2 });
    const { db } = await import("@/lib/db");
    expect(db.write.$transaction).toHaveBeenCalledTimes(1);
    expect(h.tx.honor.updateMany).toHaveBeenCalledTimes(2);
    const audits = h.appendAuditRow.mock.calls.map((c) => c[1] as { ts: Date });
    expect(audits).toHaveLength(2);
    expect(new Set(audits.map((a) => a.ts.getTime())).size).toBe(1);
  });

  it.each([
    [{ ids: [], decision: "undo" }],
    [{ ids: ["c1", "c1"], decision: "undo" }],
    [{ ids: ["c1", 7], decision: "undo" }],
    [{ ids: ["c1"], id: "c1", decision: "undo" }],
    [{ ids: ["c1"], decision: "reject" }],
  ])("400s a malformed ids body %j", async (body) => {
    const res = await POST(request(body, CURATOR) as never);
    expect(res.status).toBe(400);
    expect(h.tx.honor.updateMany).not.toHaveBeenCalled();
  });

  it("403s a non-curator", async () => {
    const res = await POST(request({ id: "honor-1", decision: "undo" }, NOBODY) as never);
    expect(res.status).toBe(403);
  });
});
