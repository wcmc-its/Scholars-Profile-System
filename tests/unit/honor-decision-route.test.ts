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
      data: { status: "rejected" },
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
      fieldsChanged: ["status"],
      targetEntityType: "honor",
      beforeValues: expect.objectContaining({ status: "pending" }),
      afterValues: expect.objectContaining({ status: "published" }),
    });
  });
});
