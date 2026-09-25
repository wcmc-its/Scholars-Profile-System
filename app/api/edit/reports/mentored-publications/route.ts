/**
 * GET /api/edit/reports/mentored-publications — the Mentored publications
 * report (`/edit/reports/7`) as a three-sheet `.xlsx` attachment. Same query
 * string the page renders (`years`, `mtype`, `tail`, `pubs`, and the rail's
 * post-load facets `window` / `position` / `pubyear` / `mentor` / `withpubs`,
 * applied by the same `applyMentoredPubsFacets` the page uses, so the
 * workbook holds what the page shows — see `parseMentoredPubsParams`; `view`
 * and `q` are accepted and ignored, they are page-only),
 * same scope gate (`getReportScopes`), same type resolution
 * (`resolveMentorshipTypes`: absent → the caller's default, a roster type
 * outside their scopes silently dropped, never widened). `pubs=all` builds
 * the "all learner publications" workbook (different Summary / Raw Data
 * columns, " All Pubs" in the filename).
 *
 * Gate order: no session → 401 · no report scope at all → 403 · malformed
 * params → 400 · else the workbook. The middleware's `/api/edit/*` 401 is
 * only the coarse layer; the scope check is this handler's.
 *
 * `force-dynamic` + `no-store`: a download is never cached. Data volume is
 * ~1–2k rows, well inside CloudFront's 30s origin-read budget.
 */
import { NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { applyMentoredPubsFacets } from "@/lib/edit/mentored-publications-facets";
import { parseMentoredPubsParams } from "@/lib/edit/mentored-publications-params";
import {
  defaultMentoredPubsYears,
  HIGH_IMPACT_THRESHOLD,
  loadMentoredGradYears,
  loadMentoredPublicationsReport,
} from "@/lib/edit/mentored-publications-report";
import {
  buildMentoredPublicationsWorkbook,
  downloadFilename,
} from "@/lib/edit/mentored-publications-xlsx";
import { MENTORSHIP_TYPE_LABEL, resolveMentorshipTypes } from "@/lib/edit/mentorship-type";
import { getReportScopes, MENTORED_PUBS_REPORT } from "@/lib/edit/report-access";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getEffectiveEditSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const scopes = await getReportScopes(session, MENTORED_PUBS_REPORT);
  if (scopes.size === 0) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const parsed = parseMentoredPubsParams(new URL(request.url).searchParams);
  if (!parsed.ok) {
    return new NextResponse(parsed.error, { status: 400 });
  }
  const { tail, pubs } = parsed.value;
  const types = resolveMentorshipTypes(parsed.value.types, scopes);
  const loaderScopes = [...scopes];

  // Same default as the page: the two most recent graduation years across
  // the selected types, plus "unknown" when they have year-less learners.
  const years =
    parsed.value.years ??
    defaultMentoredPubsYears(await loadMentoredGradYears(loaderScopes, types));
  const report = applyMentoredPubsFacets(
    await loadMentoredPublicationsReport({
      scopes: loaderScopes,
      types,
      gradYears: years.length > 0 ? years : null,
      tail,
      pubs,
    }),
    parsed.value,
    HIGH_IMPACT_THRESHOLD,
  );
  const buffer = await buildMentoredPublicationsWorkbook(report);
  // ponytail: up to two type labels fit a filename; more reads "Mixed" — the
  // Query & Assumptions sheet carries the full list.
  const typesLabel =
    types.length <= 2 ? types.map((k) => MENTORSHIP_TYPE_LABEL[k]).join("+") : "Mixed";
  const filename = downloadFilename(typesLabel, years, report.generatedAt, pubs);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(buffer.byteLength),
      "cache-control": "no-store",
    },
  });
}
