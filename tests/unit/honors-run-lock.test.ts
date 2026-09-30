/**
 * The honors run lock (lib/honors/run-lock.ts), against an in-memory run table
 * that enforces the real UNIQUE on `active_list_id`.
 *
 * Load-bearing: a run only ever claims its OWN row. A scheduled (all-lists) run
 * never takes over a Run now's queued row, it skips that list; a Run now
 * execution claims exactly the row named by its run id, once; and a stale
 * holder (a crashed run) is expired rather than blocking forever.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimHonorRun,
  expireStaleHonorRun,
  insertActiveHonorRun,
  isUniqueViolation,
} from "@/lib/honors/run-lock";

import { fakeHonorListRuns } from "../util/fake-honor-list-runs";

const LIST = "nai-fellows";
const OTHER = "bwf-cams";
const HOUR = 60 * 60 * 1000;

let store: ReturnType<typeof fakeHonorListRuns>;
// The fake implements only the delegate methods the lock calls.
let client: Parameters<typeof claimHonorRun>[0];
beforeEach(() => {
  store = fakeHonorListRuns();
  client = store as unknown as typeof client;
});

/** What the Run now route writes: a queued row holding the list's lock. */
const queueManual = () =>
  insertActiveHonorRun(client, {
    listId: LIST,
    trigger: "manual",
    status: "queued",
    requestedByCwid: "cur1001",
  });

describe("scheduled run vs a Run now request", () => {
  it("a scheduled run does NOT claim a manual queued row: it skips that list", async () => {
    const manual = await queueManual();
    const claim = await claimHonorRun(client, { listId: LIST, trigger: "schedule" });
    expect(claim).toEqual({ kind: "busy" });
    // The manual row is untouched and still waiting for ITS execution.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      id: manual.id,
      status: "queued",
      trigger: "manual",
      startedAt: null,
      activeListId: LIST,
    });
    // ...which then claims it by id.
    expect(
      await claimHonorRun(client, { listId: LIST, trigger: "manual", runId: manual.id }),
    ).toEqual({ kind: "claimed", id: manual.id });
    expect(store.rows[0]).toMatchObject({ status: "running", activeListId: LIST });
  });

  it("a scheduled run opens its own row on a list with nothing in flight", async () => {
    await queueManual();
    const claim = await claimHonorRun(client, { listId: OTHER, trigger: "schedule" });
    expect(claim.kind).toBe("claimed");
    const own = store.rows.find((r) => r.listId === OTHER);
    expect(own).toMatchObject({ trigger: "schedule", status: "running", activeListId: OTHER });
  });

  it("a Run now execution claims its row exactly once", async () => {
    const manual = await queueManual();
    const [a, b] = await Promise.all([
      claimHonorRun(client, { listId: LIST, trigger: "manual", runId: manual.id }),
      claimHonorRun(client, { listId: LIST, trigger: "manual", runId: manual.id }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["claimed", "missing"]);
  });

  it("a run id for another list, or an unknown id, claims nothing", async () => {
    const manual = await queueManual();
    expect(
      await claimHonorRun(client, { listId: OTHER, trigger: "manual", runId: manual.id }),
    ).toEqual({ kind: "missing" });
    expect(await claimHonorRun(client, { listId: LIST, trigger: "manual", runId: "nope" })).toEqual(
      {
        kind: "missing",
      },
    );
    expect(store.rows[0].status).toBe("queued");
  });

  it("two scheduled runs of one list: one claims, the other is busy", async () => {
    const [a, b] = await Promise.all([
      claimHonorRun(client, { listId: LIST, trigger: "schedule" }),
      claimHonorRun(client, { listId: LIST, trigger: "schedule" }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["busy", "claimed"]);
    expect(store.rows).toHaveLength(1);
  });
});

describe("stale holders", () => {
  it("a stale queued/running row is expired as failed and no longer blocks", async () => {
    await store.honorListRun.create({
      data: {
        listId: LIST,
        status: "running",
        activeListId: LIST,
        createdAt: new Date(Date.now() - 4 * HOUR),
      },
    });
    const claim = await claimHonorRun(client, { listId: LIST, trigger: "schedule" });
    expect(claim.kind).toBe("claimed");
    expect(store.rows[0]).toMatchObject({ status: "failed", activeListId: null });
    expect(store.rows[0].errorMessage).toMatch(/Did not finish/);
    expect(store.rows[1]).toMatchObject({ status: "running", activeListId: LIST });
  });

  it("expiry leaves a fresh holder and other lists alone", async () => {
    await store.honorListRun.create({
      data: {
        listId: LIST,
        status: "running",
        activeListId: LIST,
        createdAt: new Date(Date.now() - 2 * HOUR),
      },
    });
    await store.honorListRun.create({
      data: {
        listId: OTHER,
        status: "queued",
        activeListId: OTHER,
        createdAt: new Date(Date.now() - 5 * HOUR),
      },
    });
    expect(await expireStaleHonorRun(client, LIST)).toBe(0);
    expect(store.rows[0]).toMatchObject({ status: "running", activeListId: LIST });
    expect(store.rows[1]).toMatchObject({ status: "queued", activeListId: OTHER });
  });

  it("an ended run holds no lock", async () => {
    const run = await queueManual();
    await store.honorListRun.update({
      where: { id: run.id },
      data: { status: "success", activeListId: null },
    });
    expect((await queueManual()).id).not.toBe(run.id);
  });
});

it("isUniqueViolation recognises only P2002", () => {
  expect(isUniqueViolation({ code: "P2002" })).toBe(true);
  expect(isUniqueViolation({ code: "P2025" })).toBe(false);
  expect(isUniqueViolation(null)).toBe(false);
});
