import { NextResponse, type NextRequest } from "next/server";

import { apiError, API_NO_STORE } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { isFundingActive } from "@/lib/funding-active";
import { fundingRoleLabel, isPiRole } from "@/lib/funding-roles";
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
  /** This scholar's role, RAW as stored: PI | PI-Subaward | Co-PI | Co-I | Key Personnel.
   *  A stable passthrough of the source vocabulary — never relabelled here, so an existing
   *  caller keying off these tokens keeps working. For prose, use `roleLabel`.
   *
   *  `Co-PI` is InfoEd's NON-CONTACT PD/PI: the other principal investigator on an NIH
   *  multiple-PD/PI (MPI) award, holding FULL principal-investigator standing. It is not a
   *  junior or associate role, and NIH has no "co-PI" designation at all (that is NSF's
   *  term) — do not render this token verbatim in a promotion packet. */
  role: string;
  /** The role in WORDS, ready to print: "Principal Investigator", "Principal Investigator
   *  (subaward)", "Multiple Principal Investigator (MPI)" (for `Co-PI`), "Co-Investigator",
   *  "Key Personnel". Derived from `role` via the shared vocabulary; an unrecognized future
   *  source value passes through unchanged rather than rendering blank. */
  roleLabel: string;
  /** True when the role carries principal-investigator standing — `PI`, `PI-Subaward`, or
   *  `Co-PI`/MPI. Use this rather than testing `role === "PI"`, which silently excludes both
   *  the MPI and the subaward PI. `Co-I` and `Key Personnel` are false. */
  isPrincipalInvestigator: boolean;
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
      // #1881 — select only the columns the mapper below reads. Without this the
      // row drags `abstract` (@db.Text) + `keywords`/`meshDescriptorUis` (Json)
      // and ~9 other unused columns — ~100–150 KB discarded per NIH-heavy PI on
      // this Bearer cohort-bulk API.
      select: {
        externalId: true,
        source: true,
        title: true,
        role: true,
        awardNumber: true,
        funder: true,
        primeSponsor: true,
        directSponsor: true,
        isSubaward: true,
        programType: true,
        mechanism: true,
        nihIc: true,
        applId: true,
        startDate: true,
        endDate: true,
      },
      // Most-recent first; the [cwid, endDate] index serves this directly.
      orderBy: { endDate: "desc" },
    });

    const grants: GrantRecord[] = rows.map((g) => ({
      externalId: g.externalId,
      source: g.source,
      title: g.title,
      // ADDITIVE: `role` stays a raw passthrough of the stored vocabulary (an existing
      // caller may key off it); `roleLabel`/`isPrincipalInvestigator` are the new derived
      // fields, so the tool prints "Multiple Principal Investigator (MPI)" for a `Co-PI`
      // row instead of an NSF-flavoured token NIH does not use.
      role: g.role,
      roleLabel: fundingRoleLabel(g.role),
      isPrincipalInvestigator: isPiRole(g.role),
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
