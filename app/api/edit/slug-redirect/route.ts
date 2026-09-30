/**
 * POST /api/edit/slug-redirect — remove one former-URL redirect (a
 * `slug_history` row) from the Profile URLs registry (`/edit/slugs`, Redirects
 * tab → "Remove").
 *
 * Body: `{ oldSlug }`. Superuser only, re-checked live. The delete and its B03
 * audit row (`slug_redirect_remove`, target = the scholar the old URL forwarded
 * to) commit in one transaction. A slug with no redirect row returns
 * `404 not_found` (already removed, or never existed) and writes nothing.
 *
 * Effect: `/scholars/<oldSlug>` (and the root alias `/<oldSlug>`) stops
 * redirecting and 404s at once — both public routes are `force-dynamic` and not
 * edge-cached, and resolve through `slug_history` on every request. The slug
 * also becomes claimable: `checkSlugCollision` no longer sees it.
 *
 * Not re-created by the nightly ETL: `slug_history` rows are only written by
 * `reconcileScholarSlug`, which records a scholar's *current* slug as it is
 * replaced. A removed row names a slug no scholar currently holds, so no ETL
 * path writes it back; nothing needs a tombstone. (Only a later change that
 * moves some scholar OFF that same slug again would write a fresh row — a new
 * redirect, not a resurrection of this one.)
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/slug-redirect";

/** A slug is at most 255 chars in `slug_history.old_slug`. */
const MAX_SLUG = 255;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // --- authorization (403) — the registry is a superuser surface ---
  if (!session.isSuperuser) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: session.cwid,
      path: PATH,
      reason: "not_superuser",
    });
    return editError(403, "not_superuser");
  }

  // --- body shape ---
  const raw = body.oldSlug;
  if (typeof raw !== "string") return editError(400, "invalid_slug", "oldSlug");
  const oldSlug = raw.trim().toLowerCase();
  if (oldSlug.length === 0 || oldSlug.length > MAX_SLUG) {
    return editError(400, "invalid_slug", "oldSlug");
  }

  // --- write: delete + B03 audit row, one transaction ---
  let removed: { currentCwid: string } | null;
  try {
    removed = await db.write.$transaction(async (tx) => {
      const row = await tx.slugHistory.findUnique({
        where: { oldSlug },
        select: { currentCwid: true, createdAt: true, current: { select: { slug: true } } },
      });
      if (!row) return null;
      // deleteMany, not delete: a concurrent remove leaves 0 rows here rather
      // than throwing, and reads as not-found like the pre-check.
      const { count } = await tx.slugHistory.deleteMany({ where: { oldSlug } });
      if (count === 0) return null;
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "scholar",
        targetEntityId: row.currentCwid,
        action: "slug_redirect_remove",
        fieldsChanged: ["slug_history"],
        beforeValues: {
          oldSlug,
          currentSlug: row.current?.slug ?? null,
          recordedAt: row.createdAt.toISOString(),
        },
        afterValues: null,
        ts: new Date(),
        requestId,
      });
      return { currentCwid: row.currentCwid };
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  if (!removed) return editError(404, "not_found", "oldSlug");
  return editOk({ oldSlug, removed: true });
}
