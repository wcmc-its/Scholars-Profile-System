/**
 * One honors-list run in flight per list — the lock the Run now route and the
 * scraper (`etl/honors/scrape-lists.ts`) share. Server-only.
 *
 * The lock is `honor_list_run.active_list_id`: UNIQUE, nullable, set to the
 * list id while a run is `queued` or `running` and cleared to NULL when it ends
 * (success, partial, failed, or expired as stale). MySQL's unique index admits
 * any number of NULLs, so the table can hold at most ONE active row per list,
 * and the check is the INSERT itself: a second opener gets P2002 no matter how
 * the two requests interleave. (A findFirst-then-create inside a REPEATABLE
 * READ transaction does not do this: both readers see no active row and both
 * insert.)
 *
 * Stale rows: a run whose task never started or was killed never clears its
 * lock. Before opening a run, the opener expires that list's active row if it
 * is older than HONOR_LIST_RUN_STALE_MS (3h, well over the machine's 60 min
 * timeout): it becomes `failed` with a "did not finish" message and its lock is
 * released, so a crashed run cannot block Run now or the schedule forever.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { HONOR_LIST_RUN_STALE_MS } from "@/lib/honors/lists";

type RunClient = Pick<PrismaClient, "honorListRun">;

export const STALE_RUN_MESSAGE =
  "Did not finish: no end state was recorded within 3 hours, so the run was marked failed.";

/** Prisma's unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

/**
 * Release the list's lock if its holder is stale (created more than
 * HONOR_LIST_RUN_STALE_MS ago), marking that run failed. Returns the number of
 * rows expired (0 or 1). A fresh holder is left alone.
 */
export async function expireStaleHonorRun(
  client: RunClient,
  listId: string,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - HONOR_LIST_RUN_STALE_MS);
  const out = await client.honorListRun.updateMany({
    where: { activeListId: listId, createdAt: { lt: since } },
    data: {
      status: "failed",
      finishedAt: now,
      activeListId: null,
      errorMessage: STALE_RUN_MESSAGE,
    },
  });
  return out.count;
}

export type OpenHonorRun = {
  listId: string;
  trigger: "schedule" | "manual";
  status: "queued" | "running";
  requestedByCwid?: string | null;
  startedAt?: Date | null;
};

/**
 * Insert an active run row holding the list's lock. Throws P2002 (see
 * `isUniqueViolation`) when another run of the list is in flight; callers
 * decide what that means (Run now: 409; the schedule: skip the list).
 */
export async function insertActiveHonorRun(
  client: RunClient,
  run: OpenHonorRun,
): Promise<{ id: string }> {
  return client.honorListRun.create({
    data: {
      listId: run.listId,
      trigger: run.trigger,
      status: run.status,
      requestedByCwid: run.requestedByCwid ?? null,
      startedAt: run.startedAt ?? null,
      activeListId: run.listId,
    },
    select: { id: true },
  });
}

export type ClaimHonorRun =
  /** This process now owns the run row `id` (status `running`). */
  | { kind: "claimed"; id: string }
  /** Another run of the list is in flight; this one must not touch the list. */
  | { kind: "busy" }
  /** The run id this execution was started for is not a `queued` row of this
   *  list any more (expired as stale, or never written). */
  | { kind: "missing" };

/**
 * The scraper's claim for one list. A run only ever claims its OWN row:
 *
 *   - `runId` given (a Run now execution: the route queued that row and passed
 *     its id through the execution input, which reaches the task as
 *     HONORS_RUN_ID): flip exactly that row `queued` -> `running`,
 *     conditionally, so a second claimer of the same id gets `missing`.
 *   - no `runId` (the weekly schedule, or an operator's manual
 *     StartExecution): expire a stale holder, then INSERT a new `running` row
 *     holding the lock. If a fresh run holds it (typically a Run now in
 *     flight), `busy`: the caller skips the list and never takes over that
 *     row.
 */
export async function claimHonorRun(
  client: RunClient,
  args: { listId: string; trigger: "schedule" | "manual"; runId?: string | null; now?: Date },
): Promise<ClaimHonorRun> {
  const now = args.now ?? new Date();
  if (args.runId) {
    const out = await client.honorListRun.updateMany({
      where: {
        id: args.runId,
        listId: args.listId,
        status: "queued",
        activeListId: args.listId,
      },
      data: { status: "running", startedAt: now },
    });
    return out.count === 1 ? { kind: "claimed", id: args.runId } : { kind: "missing" };
  }
  await expireStaleHonorRun(client, args.listId, now);
  try {
    const run = await insertActiveHonorRun(client, {
      listId: args.listId,
      trigger: args.trigger,
      status: "running",
      startedAt: now,
    });
    return { kind: "claimed", id: run.id };
  } catch (err) {
    if (isUniqueViolation(err)) return { kind: "busy" };
    throw err;
  }
}
