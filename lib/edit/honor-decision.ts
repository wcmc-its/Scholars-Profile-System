/**
 * The approve / reject core of the honors approval queue (#1762), shared by
 * `POST /api/edit/honor/decision` and the operator job
 * `etl/bulk-confirm-strong`. The route keeps the flag, auth and body gates and
 * the undo branch; this function is everything one approve or reject writes,
 * inside the caller's transaction. See the route's docblock for why approving
 * rejects the line's pending siblings atomically, and why every audit row of
 * one decision shares the hoisted `ts`.
 *
 * It returns what the caller needs after commit: the owners whose profiles
 * changed (`affectedCwids`). It does not reflect anything itself, because the
 * route reflects through Next (`revalidatePath`) and the job cannot.
 */
import type { Prisma } from "@/lib/generated/prisma/client";
import { appendAuditRow } from "@/lib/edit/audit";

export type HonorStoredRow = {
  id: string;
  cwid: string;
  status: string;
  name: string;
  organization: string;
  year: number | null;
  /** The roster-LINE identity. Siblings share it. */
  sourceRef: string | null;
  /** CURATOR | SELF | a feed identifier. */
  source?: string;
  decidedByCwid?: string | null;
  decidedAt?: Date | null;
  rejectionReason?: string | null;
  supersededById?: string | null;
};

/** The audit before/after payload. Deliberately small: identity + what moved. */
export function honorSnapshot(row: HonorStoredRow) {
  return {
    id: row.id,
    cwid: row.cwid,
    status: row.status,
    name: row.name,
    organization: row.organization,
    year: row.year,
    decidedByCwid: row.decidedByCwid ?? null,
    rejectionReason: row.rejectionReason ?? null,
    supersededById: row.supersededById ?? null,
  };
}

export type HonorDecisionResult =
  | { kind: "not_found" }
  | { kind: "not_pending"; status: string }
  | { kind: "line_already_awarded" }
  | {
      kind: "ok";
      status: "published" | "rejected";
      siblingsRejected: number;
      affectedCwids: string[];
    };

/**
 * Approve or reject ONE pending honor inside `tx`. `realCwid` is the human who
 * decided (never an impersonated identity); it is stamped on the row and on
 * every audit row. `reason` is reject-only and already validated.
 */
export async function decideHonor(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    decision: "approve" | "reject";
    reason: string | null;
    realCwid: string;
    impersonatedCwid: string | null;
    requestId: string;
    ts: Date;
  },
): Promise<HonorDecisionResult> {
  const { id: honorId, decision, reason, realCwid, impersonatedCwid, requestId, ts } = args;

  const row = (await tx.honor.findUnique({ where: { id: honorId } })) as HonorStoredRow | null;
  if (!row) return { kind: "not_found" as const };

  // Only a pending row is decidable, re-checked INSIDE the transaction so two
  // curators racing the same row cannot both decide it. This is also what
  // enforces `rejected` being terminal — the DB does not.
  if (row.status !== "pending") return { kind: "not_pending" as const, status: row.status };

  // A line can only be awarded ONCE. If a sibling is already `published`, this
  // row is a competing claim on an award that has been given away — approving
  // it credits TWO people with one fellowship, the exact failure the sibling
  // rejection below exists to prevent. Cannot arise while this route is the
  // only writer, but `status` has no DB guard and the Phase 2 seed is written
  // out of band, so it is guarded rather than assumed.
  if (decision === "approve" && row.sourceRef) {
    const awarded = await tx.honor.findFirst({
      where: { sourceRef: row.sourceRef, status: "published", id: { not: row.id } },
      select: { id: true },
    });
    if (awarded) return { kind: "line_already_awarded" as const };
  }

  const nextStatus = decision === "approve" ? "published" : "rejected";
  const updated = (await tx.honor.update({
    where: { id: honorId },
    data: {
      status: nextStatus,
      decidedByCwid: realCwid,
      decidedAt: ts,
      rejectionReason: decision === "reject" ? reason : null,
      supersededById: null,
    },
  })) as HonorStoredRow;

  await appendAuditRow(tx, {
    actorCwid: realCwid,
    impersonatedCwid,
    targetEntityType: "honor",
    requestId,
    targetEntityId: row.id,
    action: "honor_update",
    fieldsChanged:
      decision === "reject" && reason
        ? ["status", "decidedByCwid", "decidedAt", "rejectionReason"]
        : ["status", "decidedByCwid", "decidedAt"],
    beforeValues: honorSnapshot(row),
    afterValues: honorSnapshot(updated),
    ts,
  });

  // Approving a contested line rejects its siblings, atomically. `sourceRef`
  // is the roster-LINE identity, so siblings are the other candidates for the
  // same award. A NULL sourceRef identifies no line ⇒ it has no siblings.
  // `status: "pending"` leaves an already-`rejected` sibling untouched: it is
  // terminal, and re-writing it would emit a second audit row saying nothing.
  let siblingsRejected = 0;
  // Every owner whose public profile this decision changes. Collected INSIDE
  // the transaction because siblings can belong to DIFFERENT scholars; the
  // reflection itself must happen after commit.
  const affectedCwids = new Set<string>([row.cwid]);
  if (decision === "approve" && row.sourceRef) {
    const siblings = (await tx.honor.findMany({
      where: { sourceRef: row.sourceRef, status: "pending", id: { not: row.id } },
    })) as HonorStoredRow[];
    for (const sibling of siblings) {
      const after = (await tx.honor.update({
        where: { id: sibling.id },
        // `supersededById` is what lets an undo of THIS approval find and
        // restore exactly these rows.
        data: {
          status: "rejected",
          decidedByCwid: realCwid,
          decidedAt: ts,
          rejectionReason: null,
          supersededById: row.id,
        },
      })) as HonorStoredRow;
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "honor",
        requestId,
        targetEntityId: sibling.id,
        action: "honor_update",
        fieldsChanged: ["status", "decidedByCwid", "decidedAt", "supersededById"],
        beforeValues: honorSnapshot(sibling),
        afterValues: honorSnapshot(after),
        ts,
      });
      affectedCwids.add(sibling.cwid);
      siblingsRejected++;
    }
  }
  return {
    kind: "ok" as const,
    status: nextStatus,
    siblingsRejected,
    affectedCwids: [...affectedCwids],
  };
}
