/**
 * `POST /api/edit/grant-attribution/requeue` — #3071. Body `{ id }`, a grant
 * externalId. Sends an award the weekly check settled on its own (shown, or
 * hidden as someone else's) back to the curator queue: the "Move back to
 * review" on an auto-confirmed row and the report's "Send to review".
 *
 * A queued award is always hidden (attribution-plan invariant 5), so a shown
 * award gets a system-unverified hide again; a hidden one keeps its own. The
 * review is written pending WITH this curator as `decidedByCwid`: that marks it
 * reopened-from-decision (`isReopenedFromDecision`), so later runs only
 * refresh it and never withdraw it or lift its hide on their own. A curator's
 * confirm or "Not this person" then settles it through the decision route.
 *
 * Refused: an award with no score row (the check never judged it), one
 * already pending or decided by a curator (decided rows have their own "Move
 * back to review"), and one the age rule hides. Same gates as the decision
 * route. One transaction; no read-after-write.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { runAfterResponse } from "@/lib/edit/after-response";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  canDecideGrantAttribution,
  isGrantAttributionQueueEnabled,
} from "@/lib/edit/grant-attribution-queue";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";
import { reflectGrantSuppressions } from "@/lib/edit/search-suppression";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/grant-attribution/requeue";

/** The ETL's createdBy markers (etl/reporter-grants/index.ts). */
const SYSTEM_UNVERIFIED = "system-unverified";
const SYSTEM_RECENCY = "system-recency";

const REQUEUE_REASON =
  "RePORTER grant sent back to the grant attribution queue by a curator. " +
  "Hidden until a curator confirms it.";

class Refused extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: "not_found" | "already_pending" | "decided" | "hidden_by_age" | "state_changed",
  ) {
    super(code);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isGrantAttributionQueueEnabled()) return new NextResponse(null, { status: 404 });

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  if (impersonatedCwid !== null) return editError(403, "impersonation_refused");
  if (!canDecideGrantAttribution(session)) return editError(403, "not_grant_curator");

  const id = body.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 64)
    return editError(400, "invalid_body", "id");

  const ts = new Date();
  let created: string | null;
  try {
    created = await db.write.$transaction(async (tx) => {
      const score = await tx.grantAttributionScore.findUnique({ where: { grantExternalId: id } });
      if (!score) throw new Refused(404, "not_found");
      const review = await tx.grantAttributionReview.findUnique({ where: { grantExternalId: id } });
      if (review?.status === "pending") throw new Refused(409, "already_pending");
      if (review && review.status !== "withdrawn") throw new Refused(409, "decided");

      // The age rule takes an award out of the scorer's scope for good, even
      // after a person revoked its hide (the ETL's existingRecencyHides).
      const aged = await tx.suppression.findFirst({
        where: { entityType: "grant", entityId: id, createdBy: SYSTEM_RECENCY },
        select: { id: true },
      });
      if (aged) throw new Refused(409, "hidden_by_age");
      const active = await tx.suppression.findMany({
        where: { entityType: "grant", entityId: id, revokedAt: null },
        select: { createdBy: true },
      });

      let hideId: string | null = null;
      if (!active.some((s) => s.createdBy === SYSTEM_UNVERIFIED)) {
        hideId = (
          await tx.suppression.create({
            data: {
              entityType: "grant",
              entityId: id,
              reason: REQUEUE_REASON,
              createdBy: SYSTEM_UNVERIFIED,
            },
          })
        ).id;
      }

      const fields = {
        score: score.score,
        band: score.band,
        cues: score.cues as Prisma.InputJsonValue,
        evidenceKey: score.evidenceKey,
        award: score.award as Prisma.InputJsonValue,
        status: "pending",
        decidedByCwid: realCwid,
        decidedAt: ts,
        rejectionReason: null,
        decisionEffects: Prisma.DbNull,
        reopenedAt: ts,
        scoredAt: score.scoredAt,
        lastSeenAt: ts,
      };
      if (review) {
        const claimed = await tx.grantAttributionReview.updateMany({
          where: { id: review.id, status: "withdrawn" },
          data: fields,
        });
        if (claimed.count !== 1) throw new Refused(409, "state_changed");
      } else {
        await tx.grantAttributionReview.create({
          data: { cwid: score.cwid, grantExternalId: id, ...fields },
        });
      }

      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "grant",
        targetEntityId: id,
        action: "grant_attribution_requeue",
        fieldsChanged: ["status"],
        beforeValues: { band: score.band, review_status: review?.status ?? null },
        afterValues: { review_status: "pending", created: hideId },
        ts,
        requestId,
      });
      return hideId;
    });
  } catch (err) {
    // A concurrent create of the same review trips the unique key.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return editError(409, "already_pending", "id");
    }
    if (err instanceof Refused) return editError(err.status, err.code, "id");
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // A shown award is hidden again: bust its profiles, then search.
  if (created) {
    try {
      const slugs = (await resolveAffectedProfiles("grant", id, null)).map((a) => a.slug);
      await reflectVisibilityChange(slugs);
    } catch (err) {
      logEditFailure(`${PATH}#reflect`, err);
    }
    const hide = created;
    runAfterResponse(async () => {
      await reflectGrantSuppressions([{ suppressionId: hide, entityId: id }]);
    });
  }

  return editOk({ status: "pending", hidden: created !== null });
}
