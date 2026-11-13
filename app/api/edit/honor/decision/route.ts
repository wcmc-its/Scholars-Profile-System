/**
 * `POST /api/edit/honor/decision` — issue #1762, the approval queue's write.
 *
 * Moves a `pending` honor to `published` or `rejected`. Gated on
 * `isSuperuser || isHonorsCurator`, mirroring `/edit/honors-queue`, and flag-gated
 * behind `HONORS_APPROVAL_QUEUE` (off ⇒ 404, like the page).
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
 *
 * ONE `ts` FOR THE WHOLE DECISION. The N+1 audit rows an approval writes share a
 * single hoisted timestamp (plus the already-threaded `requestId`), which is what
 * identifies them as ONE decision rather than N unrelated edits. `ts` feeds
 * `row_hash` (`lib/edit/audit.ts`), so it must be fixed before the INSERTs, not
 * per row — the shape `core-claim/bulk` uses and the plain honor route does not
 * (it has no batch).
 *
 * UNDO (`decision: "undo"`). Reverts ONE queue decision to `pending`: the row's
 * `decidedAt` must be set, or the row must come from a feed (a seeded decision,
 * see `undoable()`), so a hand-entered or self-asserted `published` row (which
 * the queue never decided) can never be knocked back into the queue and off a
 * profile. Undoing an APPROVAL also restores the siblings that approval
 * auto-rejected — exactly the rows whose `supersededById` names it — in the same
 * transaction, so the line comes back whole. An auto-rejected sibling cannot be
 * undone on its own (409 `superseded`): reopening it next to a published winner
 * would put a second live claim on an awarded line; undo the approval instead.
 * Undoing a MANUAL rejection is refused (409 `line_already_awarded`) once another
 * candidate on the same line is `published`: reject A, approve B, undo A would
 * otherwise reopen a contested claim next to the winner. Undo B first.
 * Each reverted row gets its own `honor_update` audit row under the one `ts`.
 *
 * UNDO IS ALL-OR-NOTHING AND RACE-SAFE. `ids` (instead of `id`) undoes several
 * rows — a multi-row "None of these" — in ONE transaction: any refusal throws and
 * rolls back every row, so the card is never left half-reopened. Each transition
 * is a conditional `updateMany` keyed on the decided status the guards just read,
 * so of two concurrent undos only one matches a row; the loser's count is 0 and
 * it rolls back with a 409 instead of writing a second audit trail.
 *
 * DECISION METADATA. Every approve/reject stamps `decidedByCwid` (the REAL actor,
 * never the impersonated identity — same as the audit row) and `decidedAt`; a
 * reject may carry a short `reason`. An undo clears all four decision columns.
 *
 * TERMINALITY IS ENFORCED HERE OR NOWHERE. The migration asserts `rejected` is
 * terminal so a re-run of the feed cannot re-propose a row a human turned down,
 * but nothing in the DB enforces it: `status` is a bare ENUM with no CHECK and no
 * trigger, and all 9 transitions are legal. The `status !== "pending"` guard below
 * IS that enforcement. Undo is the one deliberate exception, and it is scoped to
 * rows the queue itself decided.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  decideHonor,
  honorSnapshot as snapshot,
  type HonorStoredRow,
} from "@/lib/edit/honor-decision";
import { isHonorQueueEnabled } from "@/lib/edit/honor-queue";
import { editError, editOk, readEditRequest } from "@/lib/edit/request";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";

export const dynamic = "force-dynamic";

/** The stored honor shape the undo branch reads (shared with the decision core). */
type StoredRow = HonorStoredRow;

/** Longest reason stored — the column is VARCHAR(255). */
const REJECTION_REASON_MAX = 255;

/** The four decision columns an undo clears. */
const CLEARED_DECISION = {
  decidedByCwid: null,
  decidedAt: null,
  rejectionReason: null,
  supersededById: null,
} as const;

/** Most rows one undo may revert — a contested line's candidates, not a bulk tool. */
const UNDO_MAX_IDS = 50;

/**
 * Whether a decided row may go back to pending: the queue decided it
 * (`decidedAt` set), or it came from a feed (seeded straight to published or
 * rejected before decisions were recorded, the Known tab's "Move to Possible"
 * and Rejected's "Restore"). Never a hand-entered (`CURATOR`) or self-asserted
 * (`SELF`) row: those never came through the queue, and undoing one would knock
 * it off a profile into a queue it never belonged to.
 */
function undoable(row: StoredRow): boolean {
  if (row.status === "pending") return false;
  if (row.decidedAt) return true;
  return row.source !== undefined && row.source !== "CURATOR" && row.source !== "SELF";
}

/** An undo refusal, thrown so the WHOLE undo transaction rolls back. */
class UndoRefused extends Error {
  constructor(readonly code: "not_found" | "not_undoable" | "superseded" | "line_already_awarded") {
    super(code);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isHonorQueueEnabled()) return new NextResponse(null, { status: 404 });

  // The shared preamble: origin check, identity, body parse + size limits, and the
  // requestId the audit row requires. Hand-rolling identity here would let this
  // route drift from every other /api/edit/* write.
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // Cross-scholar surface ⇒ superuser OR the honors_curator role (#1762 — the
  // Research Dean's office self-serves). Deliberately NOT a leg on
  // `authorizeOverviewWrite`, whose first leg is `self`: a scholar (or their
  // proxy) could otherwise approve the pending honor on their own profile, which
  // is the entire thing this gate exists to prevent.
  //
  // `||`, never a bare curator read — `app/api/auth/session/route.ts` reports
  // `isDeveloper: false` FOR a superuser to skip a redundant LDAPS call, and a
  // bare role read inherits that shape and locks superusers out.
  if (!session.isSuperuser && session.isHonorsCurator !== true) {
    return new NextResponse(null, { status: 403 });
  }

  const decision =
    body.decision === "approve" || body.decision === "reject" || body.decision === "undo"
      ? body.decision
      : null;
  if (!decision) return editError(400, "invalid_body", "decision");
  // `ids` is undo-only: every row a multi-row decision wrote, reverted together.
  let undoIds: string[] | null = null;
  if (body.ids !== undefined) {
    const ids = body.ids;
    if (
      decision !== "undo" ||
      body.id !== undefined ||
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > UNDO_MAX_IDS ||
      !ids.every((x): x is string => typeof x === "string" && x.length > 0) ||
      new Set(ids).size !== ids.length
    ) {
      return editError(400, "invalid_body", "ids");
    }
    undoIds = ids;
  }
  const honorId = undoIds ? undoIds[0] : typeof body.id === "string" ? body.id : null;
  if (!honorId) return editError(400, "invalid_body", "id");
  // Optional, reject-only. Blank ⇒ no reason. Over-long is a 400 rather than a
  // silent truncation: the column is VARCHAR(255) and MySQL strict mode would
  // otherwise fail the whole transaction.
  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string" || decision !== "reject") {
      return editError(400, "invalid_body", "reason");
    }
    const trimmed = body.reason.trim();
    if (trimmed.length > REJECTION_REASON_MAX) return editError(400, "invalid_body", "reason");
    reason = trimmed.length > 0 ? trimmed : null;
  }

  // Hoisted: ONE timestamp for every audit row this decision writes. See the note
  // above — per-row `new Date()` would make the N+1 rows look unrelated.
  const ts = new Date();

  try {
    const result = await db.write.$transaction(async (tx) => {
      if (decision === "undo") {
        const ids = undoIds ?? [honorId];
        const affected = new Set<string>();
        let siblingsRestored = 0;
        // Every refusal THROWS (never returns) so rows already reverted earlier in
        // this loop roll back with it — see the all-or-nothing note above.
        for (const id of ids) {
          const row = (await tx.honor.findUnique({ where: { id } })) as StoredRow | null;
          if (!row) throw new UndoRefused("not_found");
          // Only a decision the QUEUE made is undoable — see the undo note above.
          if (!undoable(row)) throw new UndoRefused("not_undoable");
          if (row.supersededById) throw new UndoRefused("superseded");
          // A manual rejection on a line another candidate has since WON would
          // reopen a contested claim next to a published winner. Rows undone in
          // this same request are not "another candidate".
          if (row.status === "rejected" && row.sourceRef) {
            const awarded = await tx.honor.findFirst({
              where: { sourceRef: row.sourceRef, status: "published", id: { notIn: ids } },
              select: { id: true },
            });
            if (awarded) throw new UndoRefused("line_already_awarded");
          }
          // Conditional on the decided state just read: a concurrent undo that got
          // here first has already moved it, so this matches nothing and we refuse.
          const claimed = await tx.honor.updateMany({
            where: {
              id: row.id,
              status: row.status as "published" | "rejected",
              decidedAt: row.decidedAt ?? null,
              supersededById: null,
            },
            data: { status: "pending", ...CLEARED_DECISION },
          });
          if (claimed.count !== 1) throw new UndoRefused("not_undoable");
          const reverted: StoredRow = { ...row, status: "pending", ...CLEARED_DECISION };
          await appendAuditRow(tx, {
            actorCwid: realCwid,
            impersonatedCwid,
            targetEntityType: "honor",
            requestId,
            targetEntityId: row.id,
            action: "honor_update",
            fieldsChanged: ["status", "decidedByCwid", "decidedAt", "rejectionReason"],
            beforeValues: snapshot(row),
            afterValues: snapshot(reverted),
            ts,
          });
          affected.add(row.cwid);
          if (row.status === "published") {
            const superseded = (await tx.honor.findMany({
              where: { supersededById: row.id, status: "rejected" },
            })) as StoredRow[];
            for (const sibling of superseded) {
              const restored = await tx.honor.updateMany({
                where: { id: sibling.id, status: "rejected", supersededById: row.id },
                data: { status: "pending", ...CLEARED_DECISION },
              });
              if (restored.count !== 1) throw new UndoRefused("not_undoable");
              const after: StoredRow = { ...sibling, status: "pending", ...CLEARED_DECISION };
              await appendAuditRow(tx, {
                actorCwid: realCwid,
                impersonatedCwid,
                targetEntityType: "honor",
                requestId,
                targetEntityId: sibling.id,
                action: "honor_update",
                fieldsChanged: ["status", "decidedByCwid", "decidedAt", "supersededById"],
                beforeValues: snapshot(sibling),
                afterValues: snapshot(after),
                ts,
              });
              affected.add(sibling.cwid);
              siblingsRestored++;
            }
          }
        }
        return {
          kind: "undone" as const,
          reverted: ids.length,
          siblingsRestored,
          affectedCwids: [...affected],
        };
      }

      // Approve / reject: the shared core (lib/edit/honor-decision.ts), also
      // run by the etl/bulk-confirm-strong operator job.
      return decideHonor(tx, {
        id: honorId,
        decision,
        reason,
        realCwid,
        impersonatedCwid,
        requestId,
        ts,
      });
    });

    if (result.kind === "not_found") return editError(404, "not_found", "id");
    if (result.kind === "not_pending") return editError(409, "not_pending", "id");
    if (result.kind === "line_already_awarded") {
      return editError(409, "line_already_awarded", "id");
    }

    // Post-commit, per owner. The profile page is cached and reads honors with
    // `status: published AND showOnProfile` — skip this and an approved honor
    // simply does not appear, which reads as "the approval didn't work". A
    // rejection is a reader no-op (both states are invisible), but it is reflected
    // too rather than special-cased: same cost, one code path.
    //
    // Failures here CANNOT roll the decision back — it is already committed — so
    // they must not abort the remaining owners either. Log and continue.
    await Promise.all(
      result.affectedCwids.map((cwid) =>
        reflectOwnerProfile(cwid).catch((error: unknown) => {
          console.warn(
            JSON.stringify({
              event: "honor_decision_reflect_failed",
              cwid,
              requestId,
              reason: error instanceof Error ? error.message : "unknown",
            }),
          );
        }),
      ),
    );

    if (result.kind === "undone") {
      return editOk({
        status: "pending",
        reverted: result.reverted,
        siblingsRestored: result.siblingsRestored,
      });
    }
    return editOk({ status: result.status, siblingsRejected: result.siblingsRejected });
  } catch (error) {
    if (error instanceof UndoRefused) {
      return error.code === "not_found"
        ? editError(404, "not_found", "id")
        : editError(409, error.code, "id");
    }
    return editError(500, "write_failed");
  }
}

/** Reflect one owner's profile page post-commit — the only surface these rows
 *  render on (no aggregate serializer reads `honor`). Mirrors the same helper in
 *  the sibling `app/api/edit/honor/route.ts`. */
async function reflectOwnerProfile(cwid: string): Promise<void> {
  const affected = await resolveAffectedProfiles("scholar", cwid, null);
  await reflectVisibilityChange(affected.map((a) => a.slug));
}
