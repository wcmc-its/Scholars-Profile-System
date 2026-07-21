import { NextResponse, type NextRequest } from "next/server";

import { apiError, API_NO_STORE } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { isFundingActive } from "@/lib/funding-active";
import { isAuthorizedBearer } from "@/lib/revalidate-auth";

/**
 * GET /api/faculty-review/[cwid]/grants
 *
 * Server-to-server read of ONE scholar's complete grant history, for the
 * WCM-internal Faculty Review Tool. Distinct from `/api/scholar/[cwid]/grants`,
 * which is a session/on-network topic-matching SEARCH widget (needs a `q`,
 * returns the top-3 matches, off by default). This route is a plain data read:
 * a caller with the service token gets every `Grant` row we hold for the cwid.
 *
 * Auth: `Authorization: Bearer <token>`, constant-time compared (reuses the
 * `/api/revalidate` gate). Tokens come from `FACULTY_REVIEW_TOKEN` (+ optional
 * `FACULTY_REVIEW_TOKEN_PREVIOUS` for rotation). No token configured ⇒ every
 * request 401s (fail closed) — the endpoint is dark until the secret is wired.
 *
 * Scope decisions (agreed with the tool owner):
 *   - Returns the FULL history — recency `Suppression`s that default-hide old
 *     grants on the public profile are NOT applied here; a review wants
 *     everything, not the display subset.
 *   - No dollar amounts: SPS never ingests award $ from InfoEd, so none exist
 *     to return. Everything else the `Grant` table holds is included.
 *   - Search enrichment (keywords / MeSH / abstract) is omitted — not needed
 *     for a per-faculty review.
 */
export const dynamic = "force-dynamic";

interface GrantRecord {
  /** Stable, source-issued unique id for the grant (the dedupe key). */
  externalId: string;
  /** "InfoEd" (WCM-administered) or "RePORTER" (NIH prior/dropped history). */
  source: string;
  title: string;
  /** This scholar's role: PI | PI-Subaward | Co-PI | Co-I | Key Personnel. */
  role: string;
  /** Sponsor-issued award number (e.g. "R01 AG067497"); null when none. */
  awardNumber: string | null;
  /** Pre-rendered sponsor display string (e.g. "NCI via Duke University"). */
  funder: string;
  /** Canonical short prime/direct sponsor names; null when not in the lookup. */
  primeSponsor: string | null;
  directSponsor: string | null;
  isSubaward: boolean;
  /** Grant | Contract with funding | Fellowship | Career | Training | … */
  programType: string;
  /** NIH-only, derived from the award number; null otherwise. */
  mechanism: string | null;
  nihIc: string | null;
  /** RePORTER application id for outbound deep-links; null for non-NIH. */
  applId: number | null;
  /** ISO date (YYYY-MM-DD). */
  startDate: string;
  endDate: string;
  /** End date + 12-month NCE grace — the same badge the profile shows. */
  isActive: boolean;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cwid: string }> },
): Promise<NextResponse> {
  const tokens = [
    process.env.FACULTY_REVIEW_TOKEN,
    process.env.FACULTY_REVIEW_TOKEN_PREVIOUS,
  ]
    .map((t) => t?.trim() ?? "")
    .filter((t) => t.length > 0);

  if (!isAuthorizedBearer(request.headers.get("authorization"), tokens)) {
    return apiError("unauthorized", 401);
  }

  const { cwid: rawCwid } = await params;
  const cwid = rawCwid?.trim() ?? "";
  if (!cwid || cwid.length > 32) {
    return apiError("invalid_cwid", 400);
  }

  const now = new Date();
  try {
    const rows = await db.read.grant.findMany({
      where: { cwid },
      // Most-recent first; the [cwid, endDate] index serves this directly.
      orderBy: { endDate: "desc" },
    });

    const grants: GrantRecord[] = rows.map((g) => ({
      externalId: g.externalId,
      source: g.source,
      title: g.title,
      role: g.role,
      awardNumber: g.awardNumber,
      funder: g.funder,
      primeSponsor: g.primeSponsor,
      directSponsor: g.directSponsor,
      isSubaward: g.isSubaward,
      programType: g.programType,
      mechanism: g.mechanism,
      nihIc: g.nihIc,
      applId: g.applId,
      startDate: isoDate(g.startDate),
      endDate: isoDate(g.endDate),
      isActive: isFundingActive(g.endDate, now),
    }));

    // 200 + empty list covers both "no grants" and "unknown cwid" — the caller
    // owns its cohort, so we don't spend a second query distinguishing them.
    // ponytail: add a Scholar existence check only if typo'd cwids prove a problem.
    return NextResponse.json(
      { cwid, count: grants.length, grants },
      { headers: API_NO_STORE },
    );
  } catch {
    return apiError("grant_lookup_failed", 500);
  }
}
