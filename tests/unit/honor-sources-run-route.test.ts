/**
 * `POST /api/edit/honor/sources/run` — the Sources tab's Run now.
 *
 * Load-bearing: it is dark unless BOTH flags are on; only a superuser or an
 * honors curator gets in; the queued run row and its audit row commit BEFORE
 * the execution starts (never an unaudited run); a list already in flight is
 * refused BY THE DATABASE (two simultaneous POSTs: exactly one 409); a stale
 * holder never blocks; the queued row's id travels to the execution; and a
 * failed start is recorded on the run row and releases the list.
 *
 * The run table is an in-memory fake that enforces the real UNIQUE on
 * `active_list_id` (tests/util/fake-honor-list-runs.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeHonorListRuns } from "../util/fake-honor-list-runs";

const h = vi.hoisted(() => ({
  readEditRequest: vi.fn(),
  appendAuditRow: vi.fn(),
  startHonorsRun: vi.fn(),
  order: [] as string[],
  store: null as unknown as ReturnType<
    typeof import("../util/fake-honor-list-runs").fakeHonorListRuns
  >,
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
      // Rolls back this transaction's inserts when the callback throws.
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => {
        const mine: string[] = [];
        const honorListRun = {
          ...h.store.honorListRun,
          create: async (args: Parameters<typeof h.store.honorListRun.create>[0]) => {
            const row = await h.store.honorListRun.create(args);
            mine.push(row.id);
            return row;
          },
        };
        try {
          const out = await fn({ honorListRun });
          h.order.push("commit");
          return out;
        } catch (err) {
          for (let i = h.store.rows.length - 1; i >= 0; i--) {
            if (mine.includes(h.store.rows[i].id)) h.store.rows.splice(i, 1);
          }
          throw err;
        }
      }),
      get honorListRun() {
        return h.store.honorListRun;
      },
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
  h.store = fakeHonorListRuns();
  h.appendAuditRow.mockImplementation(async () => void h.order.push("audit"));
  h.startHonorsRun.mockImplementation(async () => {
    h.order.push("start");
    return { executionArn: "arn:x" };
  });
});

const HOUR = 60 * 60 * 1000;

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
    expect((await POST(request({ list: HONOR_LISTS[1].id }, SUPERUSER))).status).toBe(200);
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
    expect(h.store.rows).toHaveLength(1);
    expect(h.store.rows[0]).toMatchObject({
      id: "run-1",
      listId: LIST,
      trigger: "manual",
      requestedByCwid: "cur1001",
      status: "queued",
      activeListId: LIST, // holds the list's lock while queued
    });
    expect(h.appendAuditRow).toHaveBeenCalledWith(
      expect.objectContaining({ honorListRun: expect.anything() }),
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
    // The execution carries the queued row's id, so the job claims exactly it.
    expect(h.startHonorsRun).toHaveBeenCalledWith({
      lists: [LIST],
      runId: "run-1",
      requestId: "req-1",
    });
  });

  it("409s a list already queued or running, and starts nothing", async () => {
    expect((await POST(request({ list: LIST }, SUPERUSER))).status).toBe(200);
    vi.clearAllMocks();
    const res = await POST(request({ list: LIST }, SUPERUSER));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_running" });
    expect(h.store.rows).toHaveLength(1);
    expect(h.appendAuditRow).not.toHaveBeenCalled();
    expect(h.startHonorsRun).not.toHaveBeenCalled();
  });

  it("two SIMULTANEOUS POSTs for one list: exactly one queues and starts, the other 409s", async () => {
    const [a, b] = await Promise.all([
      POST(request({ list: LIST }, SUPERUSER)),
      POST(request({ list: LIST }, CURATOR)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(h.store.rows.filter((r) => r.listId === LIST)).toHaveLength(1);
    expect(h.startHonorsRun).toHaveBeenCalledTimes(1);
    expect(h.appendAuditRow).toHaveBeenCalledTimes(1);
  });

  it("a different list is not blocked by an in-flight one", async () => {
    expect((await POST(request({ list: LIST }, SUPERUSER))).status).toBe(200);
    expect((await POST(request({ list: HONOR_LISTS[1].id }, SUPERUSER))).status).toBe(200);
  });

  it("a STALE queued/running row (older than 3h) is expired as failed and does not block", async () => {
    await h.store.honorListRun.create({
      data: {
        listId: LIST,
        status: "running",
        activeListId: LIST,
        createdAt: new Date(Date.now() - 4 * HOUR),
      },
    });
    const res = await POST(request({ list: LIST }, SUPERUSER));
    expect(res.status).toBe(200);
    const [stale, fresh] = h.store.rows;
    expect(stale).toMatchObject({ status: "failed", activeListId: null });
    expect(stale.errorMessage).toMatch(/Did not finish/);
    expect(stale.finishedAt).toBeInstanceOf(Date);
    expect(fresh).toMatchObject({ status: "queued", activeListId: LIST });
  });

  it("a FRESH running row (a scheduled run in flight) still blocks", async () => {
    await h.store.honorListRun.create({
      data: {
        listId: LIST,
        status: "running",
        activeListId: LIST,
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    });
    expect((await POST(request({ list: LIST }, SUPERUSER))).status).toBe(409);
    expect(h.store.rows[0]).toMatchObject({ status: "running", activeListId: LIST });
  });

  it("if the audit insert fails, nothing starts and the list is not left locked", async () => {
    h.appendAuditRow.mockRejectedValue(new Error("Data truncated for column 'action'"));
    await expect(POST(request({ list: LIST }, SUPERUSER))).rejects.toThrow(/truncated/);
    expect(h.startHonorsRun).not.toHaveBeenCalled();
    expect(h.store.rows).toHaveLength(0);
  });

  it("a failed start marks the run failed, releases the list, and answers 502", async () => {
    h.startHonorsRun.mockRejectedValueOnce(new Error("AccessDeniedException"));
    const res = await POST(request({ list: LIST }, SUPERUSER));
    expect(res.status).toBe(502);
    expect(h.store.rows[0]).toMatchObject({
      id: "run-1",
      status: "failed",
      activeListId: null,
      errorMessage: "Could not start the run: AccessDeniedException",
    });
    // Released: the next press can queue again.
    expect((await POST(request({ list: LIST }, SUPERUSER))).status).toBe(200);
  });
});
