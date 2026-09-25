/**
 * `POST /api/edit/news-mention/undo` — take back one or more review-queue
 * decisions, for the status bar's Undo on /edit/news-queue and
 * /edit/media-highlights-queue.
 *
 * Body: `{ decisionIds: string[] }` — the `decisionId`s returned by
 * POST /api/edit/news-mention/decision ("Approve all" and the bulk bar make one
 * decision per mention, so Undo sends them all).
 *
 * WHAT IT RESTORES. Every row stamped with one of those ids goes back to the
 * status, visibility and `enteredByCwid` it had before (lib/edit/news-decision.ts):
 * the decided row, its clip copies, the contested siblings the approval swept,
 * and a reassign's target row. A row the decision CREATED (a reassign to a
 * scholar who had no row for the article) is deleted. The stamp is then cleared,
 * so the same decision cannot be undone twice.
 *
 * ALL OR NOTHING, and refused (nothing written) when —
 *   - no row carries the id any more: already undone, or a later /edit write
 *     (hide / show / "not me", or another queue decision) touched ANY row the
 *     decision wrote ⇒ 409 `undo_unavailable`. Such a write clears the stamp on
 *     every row of the earlier decision (`invalidateDecisions`), never just the
 *     row it touched, so a decision is undoable in full or not at all;
 *   - the decision was made by someone else ⇒ 403 `not_yours`. A reviewer undoes
 *     their own click, never a colleague's;
 *   - it is older than NEWS_UNDO_WINDOW_MS ⇒ 409 `undo_expired`. The row can
 *     still be changed from the Approved / Rejected tab;
 *   - a row changed between the read and the write (conditional update on the
 *     stamp) ⇒ 409 `undo_unavailable`.
 *
 * Same gate as the decision route: NEWS_APPROVAL_QUEUE, then superuser or
 * comms_steward. Each restored row writes a `news_mention_update` audit row
 * (the existing ENUM value) with `undoOf` in the after-values; one `ts` for all.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  CLEARED_DECISION_STAMP,
  NEWS_UNDO_MAX_DECISIONS,
  NEWS_UNDO_WINDOW_MS,
  reflectOwners,
} from "@/lib/edit/news-decision";
import { isNewsQueueEnabled } from "@/lib/edit/news-queue";
import { editError, editOk, readEditRequest } from "@/lib/edit/request";
import type { NewsMentionStatus } from "@/lib/generated/prisma/enums";

export const dynamic = "force-dynamic";

type StampedRow = {
  id: string;
  cwid: string;
  status: string;
  title: string;
  detectedName: string | null;
  showOnProfile: boolean;
  enteredByCwid: string | null;
  decisionId: string | null;
  decisionAt: Date | null;
  prevStatus: string | null;
  prevShowOnProfile: boolean | null;
  prevEnteredByCwid: string | null;
};

/** Thrown inside the transaction to roll back every restore already made. */
class UndoConflict extends Error {}

function snapshot(row: {
  id: string;
  cwid: string;
  status: string;
  title: string;
  detectedName: string | null;
  showOnProfile: boolean;
}) {
  return {
    id: row.id,
    cwid: row.cwid,
    status: row.status,
    title: row.title,
    detectedName: row.detectedName,
    showOnProfile: row.showOnProfile,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isNewsQueueEnabled()) return new NextResponse(null, { status: 404 });

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  if (!session.isSuperuser && session.isCommsSteward !== true) {
    return new NextResponse(null, { status: 403 });
  }

  const raw = body.decisionIds;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > NEWS_UNDO_MAX_DECISIONS ||
    !raw.every((v) => typeof v === "string" && v.length > 0 && v.length <= 64)
  ) {
    return editError(400, "invalid_body", "decisionIds");
  }
  const decisionIds = [...new Set(raw as string[])];

  const ts = new Date();

  try {
    const result = await db.write.$transaction(async (tx) => {
      const rows = (await tx.newsMention.findMany({
        where: { decisionId: { in: decisionIds } },
      })) as StampedRow[];

      // Every requested decision must still be fully undoable.
      const found = new Set(rows.map((r) => r.decisionId));
      if (decisionIds.some((id) => !found.has(id))) return { kind: "unavailable" as const };
      if (rows.some((r) => r.enteredByCwid !== realCwid)) return { kind: "not_yours" as const };
      const now = ts.getTime();
      if (rows.some((r) => !r.decisionAt || now - r.decisionAt.getTime() > NEWS_UNDO_WINDOW_MS)) {
        return { kind: "expired" as const };
      }

      const affectedCwids = new Set<string>();
      for (const row of rows) {
        affectedCwids.add(row.cwid);
        if (row.prevStatus === null) {
          // The decision created this row (a reassign): undo removes it.
          const { count } = await tx.newsMention.deleteMany({
            where: { id: row.id, decisionId: row.decisionId },
          });
          if (count !== 1) throw new UndoConflict();
          await appendAuditRow(tx, {
            actorCwid: realCwid,
            impersonatedCwid,
            targetEntityType: "news_mention",
            requestId,
            targetEntityId: row.id,
            action: "news_mention_update",
            fieldsChanged: ["deleted"],
            beforeValues: snapshot(row),
            afterValues: { deleted: true, undoOf: row.decisionId },
            ts,
          });
          continue;
        }

        const restored = {
          status: row.prevStatus as NewsMentionStatus,
          showOnProfile: row.prevShowOnProfile ?? row.showOnProfile,
          enteredByCwid: row.prevEnteredByCwid,
        };
        // Conditional on the stamp: a write that landed since the read (and so
        // cleared it) makes this match nothing, and the whole undo rolls back.
        const { count } = await tx.newsMention.updateMany({
          where: { id: row.id, decisionId: row.decisionId },
          data: { ...restored, ...CLEARED_DECISION_STAMP },
        });
        if (count !== 1) throw new UndoConflict();
        const fieldsChanged = ["status"];
        if (restored.showOnProfile !== row.showOnProfile) fieldsChanged.push("showOnProfile");
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "news_mention",
          requestId,
          targetEntityId: row.id,
          action: "news_mention_update",
          fieldsChanged,
          beforeValues: snapshot(row),
          afterValues: {
            ...snapshot({ ...row, status: restored.status, showOnProfile: restored.showOnProfile }),
            undoOf: row.decisionId,
          },
          ts,
        });
      }
      return { kind: "ok" as const, restored: rows.length, affectedCwids: [...affectedCwids] };
    });

    if (result.kind === "unavailable") return editError(409, "undo_unavailable", "decisionIds");
    if (result.kind === "not_yours") return editError(403, "not_yours", "decisionIds");
    if (result.kind === "expired") return editError(409, "undo_expired", "decisionIds");

    await reflectOwners(result.affectedCwids, requestId);
    return editOk({ restored: result.restored });
  } catch (error) {
    if (error instanceof UndoConflict) return editError(409, "undo_unavailable", "decisionIds");
    return editError(500, "write_failed");
  }
}
