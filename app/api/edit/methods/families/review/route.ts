/**
 * POST /api/edit/methods/families/review — clear a Method-Family's review nag
 * (`docs/comms-steward-methods-visibility-spec.md` §7).
 *
 * Body `{ supercategory, familyLabel }`. Sets `reviewedAt=now` +
 * `reviewedByCwid=<actor>` on the family's `family_review_flag` row. This is a
 * pure surfacing-ledger write: it does NOT change the visibility tier (a reviewed
 * family may stay public — review and tier are orthogonal, §6). The action is
 * recorded on a `family_review` / `method_family` audit row in the SAME
 * transaction. Keyed on the STABLE `(supercategory, family_label)` identity.
 *
 * A review of a family that carries no flag row is a no-op (nothing to clear);
 * the route still 200s so the UI treats it as a successful (idempotent) clear.
 *
 * Gate order (§7/§9): COMMS_STEWARD_ENABLED off => 404; anonymous => 401 (via the
 * shared preamble); non-steward/superuser => 403 (`not_comms_steward`, logged).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { isCommsStewardEnabled } from "@/lib/auth/comms-steward";
import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { authorizeCommsStewardAction, logEditDenial } from "@/lib/edit/authz";
import { apiError } from "@/lib/api/error-response";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { familyOverlayKey } from "@/lib/api/methods-overlay";

const PATH = "/api/edit/methods/families/review";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isCommsStewardEnabled()) return apiError("not_found", 404);

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const authz = authorizeCommsStewardAction(session);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: session.cwid,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  const { supercategory, familyLabel } = body;
  if (typeof supercategory !== "string" || supercategory.length === 0) {
    return editError(400, "invalid_supercategory", "supercategory");
  }
  if (typeof familyLabel !== "string" || familyLabel.length === 0) {
    return editError(400, "invalid_family_label", "familyLabel");
  }
  const auditId = familyOverlayKey(supercategory, familyLabel);
  // The reviewing actor: the effective (impersonated) identity acted AS, falling
  // back to the real human. `reviewedByCwid` records who cleared the nag; the
  // immutable audit row carries the real human + impersonation target separately.
  const reviewedByCwid = session.cwid;
  const reviewedAt = new Date();

  try {
    await db.write.$transaction(async (tx) => {
      const existing = await tx.familyReviewFlag.findUnique({
        where: { supercategory_familyLabel: { supercategory, familyLabel } },
        select: { reviewedAt: true, reviewedByCwid: true },
      });
      if (!existing) {
        // No flag row → nothing to review. Idempotent no-op; skip the audit row
        // (no state change). The route still returns 200.
        return;
      }
      await tx.familyReviewFlag.update({
        where: { supercategory_familyLabel: { supercategory, familyLabel } },
        data: { reviewedAt, reviewedByCwid },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "method_family",
        targetEntityId: auditId,
        action: "family_review",
        fieldsChanged: ["reviewedAt"],
        beforeValues: {
          reviewed_at: existing.reviewedAt ? existing.reviewedAt.toISOString() : null,
          reviewed_by_cwid: existing.reviewedByCwid,
        },
        afterValues: {
          reviewed_at: reviewedAt.toISOString(),
          reviewed_by_cwid: reviewedByCwid,
          supercategory,
          family_label: familyLabel,
        },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ supercategory, familyLabel, reviewedAt: reviewedAt.toISOString() });
}
