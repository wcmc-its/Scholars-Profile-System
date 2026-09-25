/**
 * `POST /api/edit/honor/sources/run` — the Sources tab's Run now.
 *
 * Load-bearing: it is dark unless BOTH flags are on; only a superuser or an
 * honors curator gets in; the queued run row and its audit row commit BEFORE
 * the execution starts (never an unaudited run); a list already in flight is
 * refused; and a failed start is recorded on the run row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  startHonorsRun: vi.fn(),
  order: [] as string[],
  tx: { honorListRun: { findFirst: vi.fn(), create: vi.fn() } },
  update: vi.fn(),
}));

vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: h.readEditRequest,
}));
vi.mock("@/lib/edit/audit", () => ({ appendAuditRow: h.appendAuditRow }));
vi.mock("@/lib/honors/run-now", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/honors/run-now")>()),
  startHonorsRun: h.startHonorsRun,
}));
vi.mock("@/lib/db", () => ({
  db: {
    write: {
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => {
        const out = await fn(h.tx);
        h.order.push("commit");
        return out;
      }),
      honorListRun: { update: h.update },
    },
  },
}));

import { POST } from "@/app/api/edit/honor/sources/run/route";
import { HONOR_LISTS } from "@/lib/honors/lists";

const LIST = HONOR_LISTS[0].id;
const SUPERUSER = { cwid: "cur1001", isSuperuser: true, isHonorsCurator: false };
const CURATOR = { cwid: "cur1001", isSuperuser: false, isHonorsCurator: true };
const NOBODY = { cwid: "joe1001", isSuperuser: false, isHonorsCurator: false };

function request(body: Record<string, unknown>, session: Record<string, unknown>) {
  h.readEditRequest.mockResolvedValue({
    ok: true,
    ctx: { session, realCwid: "cur1001", impersonatedCwid: null, body, requestId: "req-1" },
  });
  return new Request("http://x/api/edit/honor/sources/run", { method: "POST" }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  process.env.HONORS_APPROVAL_QUEUE = "on";
  process.env.HONORS_RUN_NOW = "on";
  h.tx.honorListRun.findFirst.mockResolvedValue(null);
  h.tx.honorListRun.create.mockResolvedValue({ id: "run-1" });
  h.appendAuditRow.mockImplementation(async () => void h.order.push("audit"));
  h.startHonorsRun.mockImplementation(async () => {
    h.order.push("start");
    return { executionArn: "arn:x" };
  });
  h.update.mockResolvedValue({});
});

describe("gates", () => {
  it("404s when HONORS_RUN_NOW is off, before reading the request", async () => {
    process.env.HONORS_RUN_NOW = "off";
    const res = await POST(request({ list: LIST }, SUPERUSER));
    expect(res.status).toBe(404);
    expect(h.readEditRequest).not.toHaveBeenCalled();
  });

  it("404s when the honors queue itself is off", async () => {
    process.env.HONORS_APPROVAL_QUEUE = "off";
    expect((await POST(request({ list: LIST }, SUPERUSER))).status).toBe(404);
  });

  it("admits a non-superuser honors curator and a superuser; 403s anyone else", async () => {
    expect((await POST(request({ list: LIST }, CURATOR))).status).toBe(200);
    expect((await POST(request({ list: LIST }, SUPERUSER))).status).toBe(200);
    const res = await POST(request({ list: LIST }, NOBODY));
    expect(res.status).toBe(403);
    expect(h.startHonorsRun).toHaveBeenCalledTimes(2);
  });

  it("400s an unknown or missing list", async () => {
    expect((await POST(request({ list: "not-a-list" }, SUPERUSER))).status).toBe(400);
    expect((await POST(request({}, SUPERUSER))).status).toBe(400);
    expect(h.startHonorsRun).not.toHaveBeenCalled();
  });
});

describe("run", () => {
  it("queues a run row and an audit row, commits, THEN starts the execution", async () => {
    const res = await POST(request({ list: LIST }, CURATOR));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, runId: "run-1", status: "queued" });
    expect(h.tx.honorListRun.create).toHaveBeenCalledWith({
      data: { listId: LIST, trigger: "manual", requestedByCwid: "cur1001", status: "queued" },
      select: { id: true },
    });
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        actorCwid: "cur1001",
        action: "honor_list_run",
        targetEntityType: "honor_list",
        targetEntityId: LIST,
        afterValues: expect.objectContaining({ runId: "run-1", status: "queued" }),
        requestId: "req-1",
      }),
    );
    expect(h.order).toEqual(["audit", "commit", "start"]);
    expect(h.startHonorsRun).toHaveBeenCalledWith({ lists: [LIST], requestId: "req-1" });
  });

  it("409s a list already queued or running, and starts nothing", async () => {
    h.tx.honorListRun.findFirst.mockResolvedValue({ id: "run-0" });
    const res = await POST(request({ list: LIST }, SUPERUSER));
    expect(res.status).toBe(409);
    expect(h.tx.honorListRun.create).not.toHaveBeenCalled();
    expect(h.appendAuditRow).not.toHaveBeenCalled();
    expect(h.startHonorsRun).not.toHaveBeenCalled();
    // Only a FRESH queued/running row blocks — a stale one has aged out.
    const where = h.tx.honorListRun.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ listId: LIST, status: { in: ["queued", "running"] } });
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  it("if the audit insert fails, nothing starts", async () => {
    h.appendAuditRow.mockRejectedValue(new Error("Data truncated for column 'action'"));
    await expect(POST(request({ list: LIST }, SUPERUSER))).rejects.toThrow(/truncated/);
    expect(h.startHonorsRun).not.toHaveBeenCalled();
  });

  it("a failed start marks the run failed and answers 502", async () => {
    h.startHonorsRun.mockRejectedValue(new Error("AccessDeniedException"));
    const res = await POST(request({ list: LIST }, SUPERUSER));
    expect(res.status).toBe(502);
    expect(h.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({
        status: "failed",
        errorMessage: "Could not start the run: AccessDeniedException",
      }),
    });
  });
});
