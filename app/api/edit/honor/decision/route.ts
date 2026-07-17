/**
 * `POST /api/edit/honor/decision` — issue #1762, the approval queue's write.
 *
 * Moves a `pending` honor to `published` or `rejected`. Superuser-gated, mirroring
 * `/edit/honors-queue`, and flag-gated behind `HONORS_APPROVAL_QUEUE` (off ⇒ 404,
 * like the page).
 *
 * WHY `honor_update` AND NOT A NEW `honor_approved` ACTION. Approving IS a status
 * update, and `honor_create|update|delete` are already registered in the
 * `scholars_audit` ENUM. A new action value would need the #1568 five-place ritual
 * — TS union, the SQL ENUM, a migration, and a real-DB probe with a control —
 * because `appendAuditRow` runs INSIDE this transaction and an unregistered value
 * throws MySQL 1265, rolling back EVERY decision (a 500 on 100% of writes, with
 * green tests: the #1760 near-miss). `fieldsChanged: ["status"]` plus before/after
 * records the transition, so an audit reader still sees what happened. Add
 * distinct actions only when a query needs to separate "curator approved" from
 * "scholar edited" — and pay the ritual then, deliberately.
 *
 * SIBLING REJECTION IS THE POINT, NOT A FLOURISH. Rows sharing a `sourceRef` are
 * competing candidates for ONE roster line — at most one is true. Approving one
 * therefore rejects the others IN THE SAME TRANSACTION. Left to a second call, a
 * crash between them would credit two people with one award: the mismatch this
 * project keeps naming as the expensive failure (misses are cheap).
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { isHonorQueueEnabled } from "@/lib/edit/honor-queue";
import { editError, editOk, readEditRequest } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

type StoredRow = {
  id: string;
  cwid: string;
  status: string;
  name: string;
  organization: string;
  year: number | null;
  /** The roster-LINE identity. Siblings share it — see the sibling note above. */
  sourceRef: string | null;
};

/** The audit before/after payload. Deliberately small: identity + what moved. */
function snapshot(row: StoredRow) {
  return {
    id: row.id,
    cwid: row.cwid,
    status: row.status,
    name: row.name,
    organization: row.organization,
    year: row.year,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isHonorQueueEnabled()) return new NextResponse(null, { status: 404 });

  // The shared preamble: origin check, identity, body parse + size limits, and the
  // requestId the audit row requires. Hand-rolling identity here would let this
  // route drift from every other /api/edit/* write.
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // Cross-scholar surface ⇒ superuser only, for now. The `honors_curator` role
  // (#1762, Dean's office) replaces this gate when it lands — deliberately NOT a
  // leg on `authorizeOverviewWrite`, which grants every tab on every scholar.
  if (!session.isSuperuser) return new NextResponse(null, { status: 403 });

  const honorId = typeof body.id === "string" ? body.id : null;
  const decision =
    body.decision === "approve" || body.decision === "reject" ? body.decision : null;
  if (!honorId) return editError(400, "invalid_body", "id");
  if (!decision) return editError(400, "invalid_body", "decision");

  try {
    const result = await db.write.$transaction(async (tx) => {
      const row = (await tx.honor.findUnique({ where: { id: honorId } })) as StoredRow | null;
      if (!row) return { kind: "not_found" as const };
      // Only a pending row is decidable, re-checked INSIDE the transaction so two
      // curators racing the same row cannot both decide it.
      if (row.status !== "pending") return { kind: "not_pending" as const, status: row.status };

      const nextStatus = decision === "approve" ? "published" : "rejected";
      const updated = (await tx.honor.update({
        where: { id: honorId },
        data: { status: nextStatus },
      })) as StoredRow;

      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "honor",
        requestId,
        targetEntityId: row.id,
        action: "honor_update",
        fieldsChanged: ["status"],
        beforeValues: snapshot(row),
        afterValues: snapshot(updated),
        ts: new Date(),
      });

      // Approving a contested line rejects its siblings, atomically. `sourceRef`
      // is the roster-LINE identity, so siblings are the other candidates for the
      // same award. A NULL sourceRef identifies no line ⇒ it has no siblings.
      let siblingsRejected = 0;
      if (decision === "approve" && row.sourceRef) {
        const siblings = (await tx.honor.findMany({
          where: { sourceRef: row.sourceRef, status: "pending", id: { not: row.id } },
        })) as StoredRow[];
        for (const sibling of siblings) {
          const after = (await tx.honor.update({
            where: { id: sibling.id },
            data: { status: "rejected" },
          })) as StoredRow;
          await appendAuditRow(tx, {
            actorCwid: realCwid,
            impersonatedCwid,
            targetEntityType: "honor",
            requestId,
            targetEntityId: sibling.id,
            action: "honor_update",
            fieldsChanged: ["status"],
            beforeValues: snapshot(sibling),
            afterValues: snapshot(after),
            ts: new Date(),
          });
          siblingsRejected++;
        }
      }
      return { kind: "ok" as const, status: nextStatus, siblingsRejected };
    });

    if (result.kind === "not_found") return editError(404, "not_found", "id");
    if (result.kind === "not_pending") return editError(409, "not_pending", "id");
    return editOk({ status: result.status, siblingsRejected: result.siblingsRejected });
  } catch {
    return editError(500, "write_failed");
  }
}
