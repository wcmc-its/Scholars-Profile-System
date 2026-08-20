/**
 * GET /api/opportunities/[opportunityId] — GrantRecs Phase 2 opportunity detail.
 * Public + cacheable (the opportunity corpus is public). Consumed by both the
 * faculty "Grants for me" surface and the admin reverse view.
 */
import { NextResponse, type NextRequest } from "next/server";

import { apiError } from "@/lib/api/error-response";
import { db } from "@/lib/db";

const OPPORTUNITY_ID_RE = /^[a-zA-Z0-9_:.-]{1,128}$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ opportunityId: string }> },
): Promise<NextResponse> {
  const { opportunityId } = await params;
  if (!OPPORTUNITY_ID_RE.test(opportunityId)) return apiError("invalid opportunityId", 400);

  const row = await db.read.opportunity.findUnique({ where: { opportunityId } });
  // A manually-suppressed row (matcha-admin Phase 1b) is indistinguishable
  // from an absent one on this public surface.
  if (!row || row.suppressedAt != null) return apiError("opportunity not found", 404);

  // BigInt award fields aren't JSON-serializable — coerce to number for the
  // wire. The suppression trio never leaves this public, CDN-cached surface:
  // a 200 row has all three null today, but suppressedBy is a CWID and this
  // spread would publish any future partial write.
  const json = {
    ...row,
    awardCeiling: row.awardCeiling != null ? Number(row.awardCeiling) : null,
    awardFloor: row.awardFloor != null ? Number(row.awardFloor) : null,
    estimatedFunding: row.estimatedFunding != null ? Number(row.estimatedFunding) : null,
    // undefined keys are dropped by JSON.stringify.
    suppressedAt: undefined,
    suppressedBy: undefined,
    suppressReason: undefined,
  };

  return NextResponse.json(json, {
    headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" },
  });
}
