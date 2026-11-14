/**
 * POST /api/edit/title-accept: "Accept discrepancy" on a Titles queue row
 * (#3362). The operator says the auto-selected display title is correct even
 * though the row is flagged (contested, leadership lost, mismatch, unverified
 * working title, conflicting roles).
 *
 * Body: `{ cwid, fingerprint, autoTitle }`. `fingerprint` is
 * `titleAcceptFingerprint(row)` as the queue rendered it: the auto title plus
 * the inputs that flagged the row. The write upserts ONE `field_override` row
 * (`primaryTitleAccepted`) holding that fingerprint; the queue loader hides the
 * row from "Needs review" while the fingerprint still matches, and the row
 * comes back on its own when the inputs change (a new role, a different auto
 * title). A stale page posting an old fingerprint is harmless: the marker never
 * matches and the row stays listed.
 *
 * What it does NOT do: pin. `Scholar.primaryTitle` and the `primaryTitle`
 * override are untouched, so the ladder keeps choosing the title. No public
 * page changes, so there is no profile revalidation.
 *
 * Gate: `canReviewTitles` (superuser or comms steward), the same people who may
 * pin. `readEditRequest` has already enforced same-origin, the session, the
 * View-as write refusal, and stripped an observer's or content editor's
 * synthetic steward view, so an observer is refused here like any non-steward.
 *
 * Audit: `field_override` with `fields_changed: ["primaryTitleAccepted"]`.
 * `field_override` is already in the `scholars_audit` action ENUM and
 * `field_name` is a VARCHAR, so this adds no ENUM member and needs no
 * `scripts/sql/audit-log.sql` change (same reasoning as the pin write).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { TITLE_ACCEPT_FIELD, type TitleAcceptMarker } from "@/lib/edit/title-dashboard";
import { canReviewTitles, invalidateTitlesPendingCount } from "@/lib/edit/titles-queue";

const PATH = "/api/edit/title-accept";

const FINGERPRINT = /^[0-9a-f]{64}$/;
const MAX_TITLE = 1000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // --- authorization (403) ---
  if (!canReviewTitles(session)) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: typeof body.cwid === "string" ? body.cwid : "",
      path: PATH,
      reason: "not_superuser",
    });
    return editError(403, "not_superuser");
  }

  // --- validation (400) ---
  const { cwid, fingerprint, autoTitle } = body;
  if (typeof cwid !== "string" || cwid.length === 0 || cwid.length > 64) {
    return editError(400, "invalid_entity_id", "cwid");
  }
  if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) {
    return editError(400, "invalid_value", "fingerprint");
  }
  if (autoTitle !== null && (typeof autoTitle !== "string" || autoTitle.length > MAX_TITLE)) {
    return editError(400, "invalid_value", "autoTitle");
  }
  const scholar = await db.read.scholar.findUnique({ where: { cwid }, select: { cwid: true } });
  if (!scholar) return editError(400, "invalid_target", "cwid");

  const marker: TitleAcceptMarker = { fingerprint, title: autoTitle };
  const value = JSON.stringify(marker);

  try {
    await db.write.$transaction(async (tx) => {
      const key = {
        entityType_entityId_fieldName: {
          entityType: "scholar" as const,
          entityId: cwid,
          fieldName: TITLE_ACCEPT_FIELD,
        },
      };
      const existing = await tx.fieldOverride.findUnique({ where: key, select: { value: true } });
      await tx.fieldOverride.upsert({
        where: key,
        create: {
          entityType: "scholar",
          entityId: cwid,
          fieldName: TITLE_ACCEPT_FIELD,
          value,
          actorCwid: session.cwid,
        },
        update: { value, actorCwid: session.cwid },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "scholar",
        targetEntityId: cwid,
        action: "field_override",
        fieldsChanged: [TITLE_ACCEPT_FIELD],
        beforeValues: { [TITLE_ACCEPT_FIELD]: existing?.value ?? null },
        afterValues: { [TITLE_ACCEPT_FIELD]: value },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // The row leaves "Needs review": drop the memoized nav pill count.
  invalidateTitlesPendingCount();
  return editOk({ cwid, accepted: true });
}
