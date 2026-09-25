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
 *     a double click or two curators cannot stack scrapes of one site.
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
import { HONOR_LIST_RUN_STALE_MS, honorListById } from "@/lib/honors/lists";
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
  const since = new Date(ts.getTime() - HONOR_LIST_RUN_STALE_MS);

  const queued = await db.write.$transaction(async (tx) => {
    const active = await tx.honorListRun.findFirst({
      where: { listId: list.id, status: { in: ["queued", "running"] }, createdAt: { gte: since } },
      select: { id: true },
    });
    if (active) return null;
    const run = await tx.honorListRun.create({
      data: { listId: list.id, trigger: "manual", requestedByCwid: realCwid, status: "queued" },
      select: { id: true },
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
  if (!queued) return editError(409, "already_running");

  try {
    await startHonorsRun({ lists: [list.id], requestId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[honors run-now] could not start ${list.id}:`, message);
    await db.write.honorListRun
      .update({
        where: { id: queued.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          errorMessage: `Could not start the run: ${message}`.slice(0, 1024),
        },
      })
      .catch((e) => console.error("[honors run-now] could not mark the run failed", e));
    return editError(502, "start_failed");
  }

  return editOk({ runId: queued.id, status: "queued" });
}
