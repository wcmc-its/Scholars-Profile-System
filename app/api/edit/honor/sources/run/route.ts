/**
 * `POST /api/edit/honor/sources/run` — the honors Sources tab's Run now.
 *
 * Body: `{ list: "<honor list id>" }` (an id from `lib/honors/lists.ts`).
 *
 * Starts the deployed honors scrape (`scholars-honors-<env>`, see
 * `lib/honors/run-now.ts`) for that one list. It scrapes and matches only: any
 * match lands as a `pending` candidate in Possible, never on a profile.
 *
 * Gates, in order:
 *   - HONORS_APPROVAL_QUEUE and HONORS_RUN_NOW both "on", else 404 (dark).
 *   - `isSuperuser || isHonorsCurator`, else 403 — the queue's own gate, and the
 *     same `||` shape (a bare curator read locks superusers out).
 *   - a known list id, else 400.
 *   - no run of that list already queued or running (409 `already_running`), so
 *     a double click or two curators cannot stack scrapes of one site. This is
 *     enforced by the DATABASE, not a read: the queued row takes the list's
 *     lock (`honor_list_run.active_list_id`, UNIQUE; see lib/honors/run-lock.ts),
 *     so of two simultaneous POSTs exactly one inserts and the other gets P2002
 *     -> 409. A holder older than 3h (a crashed run) is expired first, so it
 *     never blocks Run now for good.
 *
 * The queued row's id travels in the execution input (`runId`), so the job
 * claims exactly this row and nothing else; the weekly run never touches it.
 *
 * AUDITED. The `queued` run row and a `honor_list_run` audit row commit in ONE
 * transaction BEFORE the execution is started, so there is never an unaudited
 * run: if the audit insert fails, nothing starts. If starting then fails, the
 * run row is marked `failed` with the reason (the audit row stays: the request
 * was made) and the route answers 502.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { isHonorQueueEnabled } from "@/lib/edit/honor-queue";
import { editError, editOk, readEditRequest } from "@/lib/edit/request";
import { honorListById } from "@/lib/honors/lists";
import {
  expireStaleHonorRun,
  insertActiveHonorRun,
  isUniqueViolation,
} from "@/lib/honors/run-lock";
import { isHonorsRunNowEnabled, startHonorsRun } from "@/lib/honors/run-now";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isHonorQueueEnabled() || !isHonorsRunNowEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  if (!session.isSuperuser && session.isHonorsCurator !== true) {
    return new NextResponse(null, { status: 403 });
  }

  const list = typeof body.list === "string" ? honorListById(body.list) : undefined;
  if (!list) return editError(400, "invalid_body", "list");

  const ts = new Date();
  // Release a dead holder's lock (older than 3h) so a crashed run cannot block
  // this list forever. A fresh holder is untouched and wins the insert below.
  await expireStaleHonorRun(db.write, list.id, ts);

  let queued: { id: string };
  try {
    queued = await db.write.$transaction(async (tx) => {
      const run = await insertActiveHonorRun(tx, {
        listId: list.id,
        trigger: "manual",
        status: "queued",
        requestedByCwid: realCwid,
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "honor_list",
        targetEntityId: list.id,
        action: "honor_list_run",
        fieldsChanged: ["status"],
        beforeValues: null,
        afterValues: { runId: run.id, listId: list.id, status: "queued", trigger: "manual" },
        ts,
        requestId,
      });
      return run;
    });
  } catch (err) {
    // The list's lock is held: another run is queued or running.
    if (isUniqueViolation(err)) return editError(409, "already_running");
    throw err;
  }

  try {
    await startHonorsRun({ lists: [list.id], runId: queued.id, requestId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[honors run-now] could not start ${list.id}:`, message);
    await db.write.honorListRun
      .update({
        where: { id: queued.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          activeListId: null,
          errorMessage: `Could not start the run: ${message}`.slice(0, 1024),
        },
      })
      .catch((e) => console.error("[honors run-now] could not mark the run failed", e));
    return editError(502, "start_failed");
  }

  return editOk({ runId: queued.id, status: "queued" });
}
