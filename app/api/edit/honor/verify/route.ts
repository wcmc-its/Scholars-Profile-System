/**
 * POST /api/edit/honor/verify — a curator marks a self-asserted honor verified
 * (or back to self-reported): the queue's User asserted tab.
 *
 * Body: `{ id: string, verified: boolean }`. Only a published `source='SELF'`
 * row qualifies; anything else is a 409 `not_self_asserted`, so this can never
 * stamp a queue-decided or hand-entered honor.
 *
 * Curator-only, the same gate as the decision route: superuser OR the
 * honors_curator role, never `self` — a scholar must not verify their own claim.
 *
 * No profile revalidation: verification changes no public surface today.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { isHonorQueueEnabled } from "@/lib/edit/honor-queue";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isHonorQueueEnabled()) return new NextResponse(null, { status: 404 });

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // `||`, never a bare curator read: see the decision route.
  if (!session.isSuperuser && session.isHonorsCurator !== true) {
    return new NextResponse(null, { status: 403 });
  }

  const id = typeof body.id === "string" && body.id.length > 0 ? body.id : null;
  if (!id) return editError(400, "invalid_body", "id");
  if (typeof body.verified !== "boolean") return editError(400, "invalid_body", "verified");
  const verified = body.verified;

  try {
    const result = await db.write.$transaction(async (tx) => {
      const row = await tx.honor.findUnique({
        where: { id },
        select: {
          id: true,
          cwid: true,
          name: true,
          organization: true,
          source: true,
          status: true,
          verifiedAt: true,
          verifiedByCwid: true,
        },
      });
      if (!row) return "not_found" as const;
      if (row.source !== "SELF" || row.status !== "published") return "not_self_asserted" as const;
      if (Boolean(row.verifiedAt) === verified) return "ok" as const; // no-op: no write, no audit
      const ts = new Date();
      const data = verified
        ? { verifiedAt: ts, verifiedByCwid: realCwid }
        : { verifiedAt: null, verifiedByCwid: null };
      await tx.honor.update({ where: { id }, data });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "honor",
        targetEntityId: row.id,
        action: "honor_update",
        fieldsChanged: ["verifiedAt", "verifiedByCwid"],
        beforeValues: { ...row },
        afterValues: { ...row, ...data },
        ts,
        requestId,
      });
      return "ok" as const;
    });
    if (result === "not_found") return editError(404, "not_found", "id");
    if (result === "not_self_asserted") return editError(409, "not_self_asserted", "id");
    return editOk({ verified });
  } catch (err) {
    logEditFailure("/api/edit/honor/verify", err);
    return editError(500, "write_failed");
  }
}
