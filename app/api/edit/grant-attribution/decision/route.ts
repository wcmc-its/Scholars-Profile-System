/**
 * `POST /api/edit/grant-attribution/decision` — #3071, the grant attribution
 * queue's write. Body `{ id | ids, decision: "confirm" | "reject" | "undo",
 * reason? }`.
 *
 *   confirm  The award is the scholar's: revoke every active system-unverified
 *            hide on it (and a curator "Not this person" hide, when a reopened
 *            item had one), so it shows on the profile.
 *   reject   "Not this person": add a CURATOR-owned suppression (created_by =
 *            the real actor's cwid). The ETL reads only its own created_by
 *            markers, so it never revokes or re-decides this one, and the
 *            system hide is left in place beside it: a later stray revoke of
 *            either still keeps the award hidden.
 *   undo     Reverse exactly what one decision did (`decisionEffects`), and
 *            move the review back to pending.
 *
 * Gated on the flag first (404), then `canDecideGrantAttribution` (superuser or
 * comms_steward, who `authorizeRevoke` already lets lift any suppression, so
 * the queue adds no power). A superuser acting under View as is refused: the
 * decision links or unlinks a real NIH award, the reporter-profile routes'
 * rule. `readEditRequest` already refuses any other View-as write.
 *
 * ALL-OR-NOTHING. `ids` decides up to GRANT_ATTRIBUTION_BULK_MAX items in ONE
 * transaction: any refusal throws and rolls every item back, so a bulk undo is
 * also one call. Every transition is a conditional `updateMany` on the status
 * just read: of two curators on one item, the loser matches nothing and gets
 * a 409. One hoisted `ts` for every audit row of the request.
 *
 * NO READ-AFTER-WRITE. The response is built from the transaction's own
 * results, never a `db.read` re-read (the replica lags the writer in prod).
 */
import { type NextRequest, NextResponse } from "next/server";

import { isReopenedFromDecision } from "@/etl/reporter-grants/attribution-plan";
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { runAfterResponse } from "@/lib/edit/after-response";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  GRANT_ATTRIBUTION_BULK_MAX,
  GRANT_REJECTION_REASON_MAX,
  NOT_THIS_PERSON_REASON_PREFIX,
  canDecideGrantAttribution,
  isGrantAttributionQueueEnabled,
} from "@/lib/edit/grant-attribution-queue";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";
import { reflectGrantSuppressions } from "@/lib/edit/search-suppression";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/grant-attribution/decision";

/** The ETL's createdBy markers (etl/reporter-grants/index.ts). */
const SYSTEM_UNVERIFIED = "system-unverified";
const SYSTEM_RECENCY = "system-recency";

type Decision = "confirm" | "reject" | "undo";
/** `reopenedBy`: the review was pending as reopened-from-decision (a requeue,
 *  or the ETL reopening a decision) when decided, by this cwid. Undo puts the
 *  marker back, so the next run still leaves it to a curator. */
type Effects = { revoked: string[]; created: string[]; reopenedBy?: string | null };

class Refused extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: "not_found" | "not_pending" | "not_undoable" | "hidden_by_age" | "state_changed",
  ) {
    super(code);
  }
}

function parseEffects(v: unknown): Effects | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Partial<Effects>;
  const ok = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === "string");
  if (!ok(e.revoked) || !ok(e.created)) return null;
  return { revoked: e.revoked, created: e.created, reopenedBy: typeof e.reopenedBy === "string" ? e.reopenedBy : null };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isGrantAttributionQueueEnabled()) return new NextResponse(null, { status: 404 });

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  if (impersonatedCwid !== null) return editError(403, "impersonation_refused");
  if (!canDecideGrantAttribution(session)) return editError(403, "not_grant_curator");

  const decision: Decision | null =
    body.decision === "confirm" || body.decision === "reject" || body.decision === "undo"
      ? body.decision
      : null;
  if (!decision) return editError(400, "invalid_body", "decision");

  let ids: string[];
  if (body.ids !== undefined) {
    const raw = body.ids;
    if (
      body.id !== undefined ||
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > GRANT_ATTRIBUTION_BULK_MAX ||
      !raw.every((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64) ||
      new Set(raw).size !== raw.length
    ) {
      return editError(400, "invalid_body", "ids");
    }
    ids = raw;
  } else if (typeof body.id === "string" && body.id.length > 0 && body.id.length <= 64) {
    ids = [body.id];
  } else {
    return editError(400, "invalid_body", "id");
  }

  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string" || decision !== "reject") {
      return editError(400, "invalid_body", "reason");
    }
    const trimmed = body.reason.trim();
    if (trimmed.length > GRANT_REJECTION_REASON_MAX) return editError(400, "invalid_body", "reason");
    reason = trimmed.length > 0 ? trimmed : null;
  }
  // "Not this person" always says why: the Not this person tab lists it.
  if (decision === "reject" && reason === null) return editError(400, "invalid_body", "reason");

  const ts = new Date();
  let result: { entities: string[]; suppressions: Array<{ suppressionId: string; entityId: string }> };
  try {
    result = await db.write.$transaction(async (tx) => {
      const entities: string[] = [];
      const suppressions: Array<{ suppressionId: string; entityId: string }> = [];

      for (const id of ids) {
        const row = await tx.grantAttributionReview.findUnique({ where: { id } });
        if (!row) throw new Refused(404, "not_found");
        const entityId = row.grantExternalId;
        const snapshot = { review_id: row.id, status: row.status, score: row.score, band: row.band };

        if (decision === "undo") {
          const effects = parseEffects(row.decisionEffects);
          const undoable =
            (row.status === "confirmed" || row.status === "rejected") &&
            row.decidedAt !== null &&
            effects !== null;
          if (!undoable || !effects) throw new Refused(409, "not_undoable");
          for (const sid of effects.revoked) {
            const r = await tx.suppression.updateMany({
              where: { id: sid, entityId, revokedAt: { not: null } },
              data: { revokedAt: null, revokedBy: null, searchReflectedAt: null },
            });
            if (r.count !== 1) throw new Refused(409, "state_changed");
            suppressions.push({ suppressionId: sid, entityId });
          }
          for (const sid of effects.created) {
            const r = await tx.suppression.updateMany({
              where: { id: sid, entityId, revokedAt: null },
              data: { revokedAt: ts, revokedBy: realCwid, searchReflectedAt: null },
            });
            if (r.count !== 1) throw new Refused(409, "state_changed");
            suppressions.push({ suppressionId: sid, entityId });
          }
          const claimed = await tx.grantAttributionReview.updateMany({
            where: { id, status: row.status, decidedAt: row.decidedAt },
            data: {
              status: "pending",
              decidedByCwid: effects.reopenedBy ?? null,
              decidedAt: effects.reopenedBy ? ts : null,
              rejectionReason: null,
              decisionEffects: Prisma.DbNull,
            },
          });
          if (claimed.count !== 1) throw new Refused(409, "not_undoable");
          await appendAuditRow(tx, {
            actorCwid: realCwid,
            impersonatedCwid,
            targetEntityType: "grant",
            targetEntityId: entityId,
            action: "grant_attribution_undo",
            fieldsChanged: ["status"],
            beforeValues: { ...snapshot, effects },
            afterValues: { review_id: row.id, status: "pending" },
            ts,
            requestId,
          });
          entities.push(entityId);
          continue;
        }

        if (row.status !== "pending") throw new Refused(409, "not_pending");

        const active = await tx.suppression.findMany({
          where: { entityType: "grant", entityId, revokedAt: null },
          select: { id: true, createdBy: true, reason: true },
        });
        // Confirming an award the age rule also hides would "confirm" it and
        // leave it hidden. The ETL never queues one, so this is a guard.
        if (active.some((s) => s.createdBy === SYSTEM_RECENCY)) {
          throw new Refused(409, "hidden_by_age");
        }
        const systemHides = active.filter((s) => s.createdBy === SYSTEM_UNVERIFIED);
        const curatorHides = active.filter((s) => s.reason.startsWith(NOT_THIS_PERSON_REASON_PREFIX));

        const effects: Effects = {
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
            if (r.count !== 1) throw new Refused(409, "state_changed");
            effects.revoked.push(s.id);
            suppressions.push({ suppressionId: s.id, entityId });
          }
        } else if (curatorHides.length === 0) {
          const sup = await tx.suppression.create({
            data: {
              entityType: "grant",
              entityId,
              reason: reason ? `${NOT_THIS_PERSON_REASON_PREFIX}: ${reason}` : NOT_THIS_PERSON_REASON_PREFIX,
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
        if (claimed.count !== 1) throw new Refused(409, "not_pending");
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "grant",
          targetEntityId: entityId,
          action: decision === "confirm" ? "grant_attribution_confirm" : "grant_attribution_reject",
          fieldsChanged: decision === "reject" && reason ? ["status", "rejectionReason"] : ["status"],
          beforeValues: snapshot,
          afterValues: { review_id: row.id, status, reason, effects },
          ts,
          requestId,
        });
        entities.push(entityId);
      }
      return { entities, suppressions };
    });
  } catch (err) {
    if (err instanceof Refused) return editError(err.status, err.code, ids.length > 1 ? "ids" : "id");
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // Post-commit: ISR + CDN for every affected profile (deduped, one batch),
  // then the search fast path after the response. Failures cannot roll the
  // decision back, so they are logged, never thrown.
  try {
    const slugs = new Set<string>();
    for (const entityId of new Set(result.entities)) {
      for (const a of await resolveAffectedProfiles("grant", entityId, null)) slugs.add(a.slug);
    }
    await reflectVisibilityChange([...slugs]);
  } catch (err) {
    logEditFailure(`${PATH}#reflect`, err);
  }
  const reflect = result.suppressions;
  runAfterResponse(async () => {
    await reflectGrantSuppressions(reflect);
  });

  return editOk({
    decision,
    decided: result.entities.length,
    status: decision === "undo" ? "pending" : decision === "confirm" ? "confirmed" : "rejected",
  });
}
