import { NextResponse, type NextRequest } from "next/server";

import { apiError, API_NO_STORE } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import {
  FACULTY_REVIEW_GRANT_SELECT,
  toGrantRecord,
  type GrantRecord,
} from "@/lib/grants/faculty-review-grant-record";
import { isAuthorizedBearer } from "@/lib/revalidate-auth";

/**
 * GET /api/faculty-review/[cwid]/grants
 *
 * Server-to-server read of ONE scholar's complete grant history. Originally
 * built for the WCM-internal Faculty Review Tool; Research Informatics
 * (#2363) reads the same route for on-demand single-cwid lookups alongside
 * their nightly all-scholars S3 export (#2359) -- same data, same shape,
 * independent credential. Distinct from `/api/scholar/[cwid]/grants`, which
 * is a session/on-network topic-matching SEARCH widget (needs a `q`, returns
 * the top-3 matches, off by default). This route is a plain data read: a
 * caller with a valid service token gets every `Grant` row we hold for the
 * cwid.
 *
 * Auth: `Authorization: Bearer <token>`, constant-time compared (reuses the
 * `/api/revalidate` gate) against the UNION of two independent consumer
 * token pairs -- `FACULTY_REVIEW_TOKEN` (+ optional `_PREVIOUS`) for the
 * Faculty Review Tool (#1855), `RESEARCH_INFORMATICS_TOKEN` (+ optional
 * `_PREVIOUS`) for Research Informatics (#2363). Deliberately two separate
 * secrets, not one shared token: each consumer's access is independently
 * auditable and revocable without touching the other's. No token configured
 * for a consumer just drops that pair from the accepted set -- if NEITHER
 * consumer has a token configured, every request 401s (fail closed).
 *
 * Scope decisions (agreed with the tool owner):
 *   - Returns the FULL history — recency `Suppression`s that default-hide old
 *     grants on the public profile are NOT applied here; a review wants
 *     everything, not the display subset.
 *   - No dollar amounts: SPS never ingests award $ from InfoEd, so none exist
 *     to return. Everything else the `Grant` table holds is included.
 *   - Search enrichment (keywords / MeSH / abstract) is omitted — not needed
 *     for a per-faculty review.
 *
 * The `GrantRecord` shape + row mapper are shared with the nightly all-scholars
 * bulk export (scripts/exports/grants-bulk-export.ts) via
 * lib/grants/faculty-review-grant-record.ts — see that module for why.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cwid: string }> },
): Promise<NextResponse> {
  const tokens = [
    process.env.FACULTY_REVIEW_TOKEN,
    process.env.FACULTY_REVIEW_TOKEN_PREVIOUS,
    process.env.RESEARCH_INFORMATICS_TOKEN,
    process.env.RESEARCH_INFORMATICS_TOKEN_PREVIOUS,
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
      // #1881 — select only the columns the mapper below reads. Without this the
      // row drags `abstract` (@db.Text) + `keywords`/`meshDescriptorUis` (Json)
      // and ~9 other unused columns — ~100–150 KB discarded per NIH-heavy PI on
      // this Bearer cohort-bulk API.
      select: FACULTY_REVIEW_GRANT_SELECT,
      // Most-recent first; the [cwid, endDate] index serves this directly.
      orderBy: { endDate: "desc" },
    });

    const grants: GrantRecord[] = rows.map((g) => toGrantRecord(g, now));

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
