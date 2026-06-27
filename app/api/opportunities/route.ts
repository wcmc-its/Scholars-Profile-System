/**
 * GET /api/opportunities — browse the funding-opportunity corpus for the matcher.
 * ADMIN-ONLY (superuser OR development-role), mirroring the reverse-matcher route;
 * `force-dynamic` so it's never CloudFront-cached.
 *
 * Curated-first: the hand-curated WCM awards (`source = "wcm_curated"`) are the
 * point of the tool — they're not widely known, so surfacing them IS the value.
 * Grants.gov NOFOs duplicate a public site and would bury the curated list, so
 * they're excluded by default; pass `includeGrantsGov=1` to fold them in.
 */
import { NextResponse, type NextRequest } from "next/server";

import { apiError } from "@/lib/api/error-response";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { asPrestige } from "@/lib/funding/prestige";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 500;
// Lower rank sorts first. Curated leads; everything else (grants.gov, …) trails.
const SOURCE_RANK: Record<string, number> = { wcm_curated: 0 };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getEffectiveEditSession();
  if (!session || !(session.isSuperuser || session.isDeveloper)) {
    return new NextResponse(null, { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  const includeGrantsGov =
    sp.get("includeGrantsGov") === "1" || sp.get("includeGrantsGov") === "true";

  let limit = 200;
  const limitRaw = sp.get("limit");
  if (limitRaw !== null) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1) return apiError("invalid limit", 400);
    limit = Math.min(n, MAX_LIMIT);
  }

  const rows = await db.read.opportunity.findMany({
    where: {
      isResearch: true,
      // reverse-view honorific gate: drop explicit-true honorifics, keep null/false
      // (the matcher path has its own honorific gate).
      isHonorific: { not: true },
      ...(includeGrantsGov ? {} : { source: { not: "grants_gov" } }),
      ...(q ? { title: { contains: q } } : {}),
    },
    select: {
      opportunityId: true,
      title: true,
      sponsor: true,
      mechanism: true,
      dueDate: true,
      source: true,
      status: true,
      prestige: true,
      isHonorific: true,
    },
  });

  // ponytail: the whole corpus is small (hundreds), so sort curated-first in JS
  // rather than leaning on a fragile source-string orderBy; slice to the cap.
  // ponytail: curated-first is preserved as the PRIMARY key; prestige leads within
  // a source group (flip to global prestige-first later if the owner wants).
  rows.sort((a, b) => {
    const ra = SOURCE_RANK[a.source ?? ""] ?? 1;
    const rb = SOURCE_RANK[b.source ?? ""] ?? 1;
    if (ra !== rb) return ra - rb;
    const pa = asPrestige(a.prestige)?.score ?? 0;
    const pb = asPrestige(b.prestige)?.score ?? 0;
    if (pa !== pb) return pb - pa;
    return (a.title ?? "").localeCompare(b.title ?? "");
  });
  const opportunities = rows.slice(0, limit);

  return NextResponse.json({ count: opportunities.length, opportunities });
}
