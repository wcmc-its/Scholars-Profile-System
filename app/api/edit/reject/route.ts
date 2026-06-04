/**
 * POST /api/edit/reject — record a self-edit "Not mine" rejection of a
 * publication and propagate it to ReCiter's gold standard (#746, #570).
 *
 * Body: `{ entityId: pmid, contributorCwid: cwid }`. A reject is publication +
 * per-author ONLY: a scholar may reject only their OWN authorship (#570 — a
 * reject means true misattribution; rejecting your own paper feeds a false
 * negative into ReCiter and degrades attribution corpus-wide, which is why the
 * UI gates this behind a soft-warning interstitial).
 *
 * The local removal (a `suppression` row, so the paper drops from the profile +
 * search immediately), the durable `ReciterPendingRefresh` intent, and the B03
 * audit row commit in ONE transaction. The ReCiter goldstandard POST is a
 * best-effort post-commit side effect that can NEVER roll back the committed
 * local write (mirrors `request-change`'s send-first/record-locally ordering and
 * `suppress`'s best-effort search reflection). The ~1h-delayed feature-generator
 * re-score is deferred to `etl/reciter-refresh`, coalesced per uid.
 *
 * Dormant behind `RECITER_REJECT_SEND` (default off): when off the endpoint
 * `503`s and the client keeps the Publication-Manager off-ramp (today's
 * behavior). When on but the ReCiter API is unconfigured (no base URL / key),
 * the reject still commits locally and the goldstandard POST is left for the
 * scanner to deliver once the secret is provisioned.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { authorizeSuppress, logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";
import { reflectSearchSuppression } from "@/lib/edit/search-suppression";
import { publicationAuthorshipExists } from "@/lib/edit/validators";
import {
  isReciterApiConfigured,
  isReciterRejectEnabled,
  postGoldStandardReject,
} from "@/lib/reciter/client";

const PATH = "/api/edit/reject";

/** The `suppression.reason` recorded for a "Not mine" reject (distinct from a Hide). */
const REJECT_REASON = "Rejected as not the author's via /edit (#746)";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // --- body shape: publication + per-author only ---
  const { entityId, contributorCwid } = body;
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }
  if (typeof contributorCwid !== "string" || contributorCwid.length === 0) {
    return editError(400, "invalid_contributor", "contributorCwid");
  }
  const pmid = entityId;
  const uid = contributorCwid; // ReCiter uid == the scholar CWID being rejected-as

  // --- authorization (403): a scholar may reject only their own authorship;
  //     a superuser may reject any (authorizeSuppress's per-author contract). ---
  const authz = authorizeSuppress(session, {
    entityType: "publication",
    entityId: pmid,
    contributorCwid: uid,
  });
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: uid,
      path: PATH,
      reason: authz.reason,
      targetEntityType: "publication",
      targetEntityId: pmid,
    });
    return editError(403, authz.reason);
  }

  // --- dormant unless enabled: when off the client keeps the Publication-Manager
  //     off-ramp. Placed after authz (so a malformed/unauthorized call still gets
  //     the right 400/403) but before any DB work (a dormant feature does none). ---
  if (!isReciterRejectEnabled()) return editError(503, "reject_disabled");

  // --- the authorship must exist (400, mirrors the per-author hide gate) ---
  const exists = await publicationAuthorshipExists(pmid, uid, db.read);
  if (!exists) return editError(400, "no_authorship", "contributorCwid");

  // --- idempotency: an un-revoked suppression for this (pmid, cwid) already
  //     exists (e.g. a prior reject or hide). Return it without re-firing ReCiter
  //     — a repeated reject must not spam the gold standard. ---
  const existing = await db.read.suppression.findFirst({
    where: { entityType: "publication", entityId: pmid, contributorCwid: uid, revokedAt: null },
    select: { id: true },
  });
  if (existing) return editOk({ suppressionId: existing.id, alreadyRejected: true });

  // --- write: suppression + pending-refresh intent + B03 audit row, one tx ---
  let result: { suppressionId: string; pendingRefreshId: string };
  try {
    result = await db.write.$transaction(async (tx) => {
      const created = await tx.suppression.create({
        data: {
          entityType: "publication",
          entityId: pmid,
          contributorCwid: uid,
          reason: REJECT_REASON,
          createdBy: session.cwid,
        },
        select: { id: true },
      });
      const pending = await tx.reciterPendingRefresh.create({
        data: { uid, pmid, rejectedBy: realCwid },
        select: { id: true },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "publication",
        targetEntityId: pmid,
        action: "publication_reject",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: {
          suppression_id: created.id,
          pending_refresh_id: pending.id,
          contributor_cwid: uid,
          reciter_source: "Scholars",
        },
        ts: new Date(),
        requestId,
      });
      return { suppressionId: created.id, pendingRefreshId: pending.id };
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // --- post-commit, all best-effort (a failure here can never undo the commit) ---
  // Drop the rejected authorship from the profile + search, exactly like a hide.
  const affected = await resolveAffectedProfiles("publication", pmid, uid);
  await reflectVisibilityChange(affected.map((a) => a.slug));
  await reflectSearchSuppression({
    suppressionId: result.suppressionId,
    entityType: "publication",
    entityId: pmid,
    contributorCwid: uid,
    affectedCwids: affected.map((a) => a.cwid),
  });

  // Best-effort gold-standard write. Dormant (unconfigured) ⇒ leave the pending
  // row for the scanner to deliver. The feature-generator re-score is NEVER fired
  // inline (heavy + ~1h-delayed) — `etl/reciter-refresh` owns it.
  if (isReciterApiConfigured()) {
    try {
      await postGoldStandardReject({ uid, pmid });
      await db.write.reciterPendingRefresh.update({
        where: { id: result.pendingRefreshId },
        data: { goldstandardSentAt: new Date() },
      });
    } catch (err) {
      // The local reject is committed; a failed/slow ReCiter POST is logged and
      // retried by the scanner (goldstandard_sent_at stays NULL). Never surfaced.
      console.error(
        JSON.stringify({
          event: "reciter_goldstandard_post_failed",
          path: PATH,
          request_id: requestId,
          uid,
          pmid,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return editOk({ suppressionId: result.suppressionId });
}
