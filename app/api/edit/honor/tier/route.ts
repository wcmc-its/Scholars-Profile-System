/**
 * POST /api/edit/honor/tier — a curator sets (or clears) the tier of honor rows.
 *
 * Body: `{ ids: string[], tier: 1..6 | null }`. `null` clears the override, so
 * the row falls back to the rules in `lib/honors/tiers.ts`. `ids` because one
 * queue card is one roster line, and a contested line carries a row per
 * candidate: they are one honor, so they take one tier together.
 *
 * Curator-only, the same gate as the decision route: superuser OR the
 * honors_curator role. Tiers are a curation aid faculty never see, so there is
 * deliberately no leg on `authorizeOverviewWrite` (whose first leg is `self`).
 * The scholar-facing honor editor (`/api/edit/honor`) never writes the column.
 *
 * No profile revalidation: the tier changes no public surface.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { isHonorQueueEnabled } from "@/lib/edit/honor-queue";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { isHonorTier } from "@/lib/honors/tiers";

export const dynamic = "force-dynamic";

/** A contested line's candidates, not a bulk tool. */
const MAX_IDS = 50;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isHonorQueueEnabled()) return new NextResponse(null, { status: 404 });

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // `||`, never a bare curator read: see the decision route.
  if (!session.isSuperuser && session.isHonorsCurator !== true) {
    return new NextResponse(null, { status: 403 });
  }

  const ids = body.ids;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_IDS ||
    !ids.every((id) => typeof id === "string" && id.length > 0)
  ) {
    return editError(400, "invalid_body", "ids");
  }
  const tier = body.tier;
  if (tier !== null && !isHonorTier(tier)) return editError(400, "invalid_body", "tier");

  try {
    const changed = await db.write.$transaction(async (tx) => {
      const rows = await tx.honor.findMany({
        where: { id: { in: ids as string[] } },
        select: { id: true, cwid: true, name: true, organization: true, tierOverride: true },
      });
      if (rows.length !== new Set(ids).size) return null;
      const ts = new Date();
      let n = 0;
      for (const row of rows) {
        if (row.tierOverride === tier) continue; // no-op: no write, no audit row
        await tx.honor.update({ where: { id: row.id }, data: { tierOverride: tier } });
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "honor",
          targetEntityId: row.id,
          action: "honor_update",
          fieldsChanged: ["tierOverride"],
          beforeValues: { ...row },
          afterValues: { ...row, tierOverride: tier },
          ts,
          requestId,
        });
        n += 1;
      }
      return n;
    });
    if (changed === null) return editError(404, "honor_not_found", "ids");
    return editOk({ changed });
  } catch (err) {
    logEditFailure("/api/edit/honor/tier", err);
    return editError(500, "write_failed");
  }
}
