/**
 * The confirm / reject core of the grant attribution queue (#3071), shared by
 * `POST /api/edit/grant-attribution/decision` and the operator job
 * `etl/bulk-confirm-strong`. The route keeps the flag, auth and body gates,
 * the by-grant opening of a review and the undo branch; this function is what
 * one confirm or reject of a PENDING review writes, inside the caller's
 * transaction. See the route's docblock for what each decision lifts or adds.
 *
 * Refusals THROW `GrantAttributionRefused` so the caller's transaction rolls
 * back (the route decides up to 50 reviews all-or-nothing). It returns the
 * award's entity id and the suppressions it touched, which the caller reflects
 * after commit (profile pages, and the OpenSearch fast path).
 */
import { isReopenedFromDecision } from "@/etl/reporter-grants/attribution-plan";
import type { GrantAttributionReview, Prisma } from "@/lib/generated/prisma/client";
import { appendAuditRow } from "@/lib/edit/audit";
import { NOT_THIS_PERSON_REASON_PREFIX } from "@/lib/edit/grant-attribution-queue";

/** The ETL's createdBy markers (etl/reporter-grants/index.ts). */
export const SYSTEM_UNVERIFIED = "system-unverified";
export const SYSTEM_RECENCY = "system-recency";

/** `reopenedBy`: the review was pending as reopened-from-decision (a requeue,
 *  or the ETL reopening a decision) when decided, by this cwid. Undo puts the
 *  marker back, so the next run still leaves it to a curator. */
export type GrantDecisionEffects = {
  revoked: string[];
  created: string[];
  reopenedBy?: string | null;
};

/** A refused decision; the route maps it to `editError(status, code)`. */
export class GrantAttributionRefused extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code:
      | "not_found"
      | "not_pending"
      | "not_undoable"
      | "hidden_by_age"
      | "state_changed"
      | "already_decided",
  ) {
    super(code);
  }
}

/**
 * Confirm or reject ONE review inside `tx`. `row` is the review as just read
 * on the writer. `realCwid` is the human who decided (stamped on the review,
 * on every suppression it revokes or creates, and on the audit row). `reason`
 * is reject-only and already validated. `opened` is the by-grant route's note
 * of what a review was before it was opened from the score, or null.
 */
export async function decideGrantReview(
  tx: Prisma.TransactionClient,
  row: GrantAttributionReview,
  args: {
    decision: "confirm" | "reject";
    reason: string | null;
    realCwid: string;
    impersonatedCwid: string | null;
    requestId: string;
    ts: Date;
    opened?: Record<string, unknown> | null;
  },
): Promise<{ entityId: string; suppressions: Array<{ suppressionId: string; entityId: string }> }> {
  const { decision, reason, realCwid, impersonatedCwid, requestId, ts } = args;
  const opened = args.opened ?? null;
  const id = row.id;
  const entityId = row.grantExternalId;
  const suppressions: Array<{ suppressionId: string; entityId: string }> = [];
  const snapshot = {
    review_id: row.id,
    status: row.status,
    score: row.score,
    band: row.band,
  };

  if (row.status !== "pending") throw new GrantAttributionRefused(409, "not_pending");

  const active = await tx.suppression.findMany({
    where: { entityType: "grant", entityId, revokedAt: null },
    select: { id: true, createdBy: true, reason: true },
  });
  // Confirming an award the age rule also hides would "confirm" it and
  // leave it hidden. The ETL never queues one, so this is a guard.
  if (active.some((s) => s.createdBy === SYSTEM_RECENCY)) {
    throw new GrantAttributionRefused(409, "hidden_by_age");
  }
  const systemHides = active.filter((s) => s.createdBy === SYSTEM_UNVERIFIED);
  const curatorHides = active.filter((s) => s.reason.startsWith(NOT_THIS_PERSON_REASON_PREFIX));

  const effects: GrantDecisionEffects = {
    revoked: [],
    created: [],
    reopenedBy: isReopenedFromDecision(row) ? row.decidedByCwid : null,
  };
  if (decision === "confirm") {
    for (const s of [...systemHides, ...curatorHides]) {
      const r = await tx.suppression.updateMany({
        where: { id: s.id, revokedAt: null },
        data: { revokedAt: ts, revokedBy: realCwid, searchReflectedAt: null },
      });
      if (r.count !== 1) throw new GrantAttributionRefused(409, "state_changed");
      effects.revoked.push(s.id);
      suppressions.push({ suppressionId: s.id, entityId });
    }
  } else if (curatorHides.length === 0) {
    const sup = await tx.suppression.create({
      data: {
        entityType: "grant",
        entityId,
        reason: reason
          ? `${NOT_THIS_PERSON_REASON_PREFIX}: ${reason}`
          : NOT_THIS_PERSON_REASON_PREFIX,
        createdBy: realCwid,
      },
    });
    effects.created.push(sup.id);
    suppressions.push({ suppressionId: sup.id, entityId });
  }

  const status = decision === "confirm" ? "confirmed" : "rejected";
  const claimed = await tx.grantAttributionReview.updateMany({
    where: { id, status: "pending" },
    data: {
      status,
      decidedByCwid: realCwid,
      decidedAt: ts,
      rejectionReason: decision === "reject" ? reason : null,
      decisionEffects: effects,
    },
  });
  if (claimed.count !== 1) throw new GrantAttributionRefused(409, "not_pending");
  await appendAuditRow(tx, {
    actorCwid: realCwid,
    impersonatedCwid,
    targetEntityType: "grant",
    targetEntityId: entityId,
    action: decision === "confirm" ? "grant_attribution_confirm" : "grant_attribution_reject",
    fieldsChanged: decision === "reject" && reason ? ["status", "rejectionReason"] : ["status"],
    beforeValues: opened ? { ...snapshot, ...opened, status: opened.review_status } : snapshot,
    afterValues: { review_id: row.id, status, reason, effects },
    ts,
    requestId,
  });
  return { entityId, suppressions };
}
