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
import { facultyPiMayHold } from "@/lib/funding/screening";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 500;
// Lower rank sorts first. Curated leads — hand-vetted WCM awards and staff-submitted
// URLs (`manual_url`, the opportunity-intake queue) — everything else trails.
const SOURCE_RANK: Record<string, number> = { wcm_curated: 0, manual_url: 0 };

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
      // Reverse-view honorific gate. 🔴 This drops NULL as well as true — Prisma's `not` compiles
      // to three-valued SQL, where `NULL <> true` is NULL, not a match. The comment here used to
      // claim it "keeps null/false"; it never did, and CHANGING IT TO MATCH THAT CLAIM WOULD BE A
      // REGRESSION. Measured on staging 2026-07-28: 29 of the 333 research, non-grants.gov rows
      // carry `is_honorific IS NULL`, and 28 of those 29 are prizes — National Medal of Science,
      // Vannevar Bush Award, Vilcek Prizes, AAAS science-journalism awards, mentoring medals.
      // NULL means the classifier never labelled the row, and empirically an unlabelled row is an
      // honorific. So the browse shows 304, not 333, and that is the right 304.
      // Stated as `false` rather than `not: true` so the intent is in the code and not in
      // Prisma's null semantics: show only rows the extractor positively classified as
      // non-honorific. Same 304 rows either way. The index now agrees — `lib/search.ts` indexes
      // unclassified AS honorific, so the recommender excludes these too (#2041).
      isHonorific: false,
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
      awardCeiling: true,
      awardFloor: true,
      // Read to DERIVE `facultyPiEligible` below; never returned — a per-row eligibility map is
      // ~500 rows of JSON the browse has no use for.
      eligibilityFlags: true,
      eligibility: true,
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
  // BigInt award fields → number for JSON (mirrors the detail route).
  const opportunities = rows.slice(0, limit).map(({ eligibility, eligibilityFlags, ...r }) => ({
    ...r,
    awardCeiling: r.awardCeiling == null ? null : Number(r.awardCeiling),
    awardFloor: r.awardFloor == null ? null : Number(r.awardFloor),
    // Screening spec §3.1 — false means no WCM faculty PI can hold this award (13.2% of the
    // corpus). The browse gates on it by default; the flag is fail-open, so absent data is `true`.
    facultyPiEligible: facultyPiMayHold(eligibilityFlags, eligibility),
  }));

  return NextResponse.json({ count: opportunities.length, opportunities });
}
