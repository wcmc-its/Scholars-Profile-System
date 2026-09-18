/**
 * GET /api/edit/reports/mentored-publications — the Mentored publications
 * report (`/edit/reports/7`) as a three-sheet `.xlsx` attachment. Same query
 * string the page renders (`years`, `program`, `tail` — see
 * `parseMentoredPubsParams`), same scope gate (`getReportScopes`).
 *
 * Gate order: no session → 401 · no report scope at all → 403 · malformed
 * params → 400 · `program` outside the caller's scopes → 403 · else the
 * workbook. The middleware's `/api/edit/*` 401 is only the coarse layer; the
 * scope check is this handler's.
 *
 * `force-dynamic` + `no-store`: a download is never cached. Data volume is
 * ~1–2k rows, well inside CloudFront's 30s origin-read budget.
 */
import { NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { parseMentoredPubsParams } from "@/lib/edit/mentored-publications-params";
import {
  loadMentoredGradYears,
  loadMentoredPublicationsReport,
} from "@/lib/edit/mentored-publications-report";
import {
  buildMentoredPublicationsWorkbook,
  downloadFilename,
} from "@/lib/edit/mentored-publications-xlsx";
import { getReportScopes, MENTORED_PUBS_REPORT, scopeAdmits } from "@/lib/edit/report-access";

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
  const { program, tail } = parsed.value;
  if (program !== null && !scopeAdmits(scopes, program)) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const loaderScopes = program !== null ? [program] : [...scopes];

  // Same default as the page: the two most recent graduation years in scope.
  const years = parsed.value.years ?? (await loadMentoredGradYears(loaderScopes)).slice(0, 2);
  const report = await loadMentoredPublicationsReport({
    scopes: loaderScopes,
    gradYears: years.length > 0 ? years : null,
    tail,
  });
  const buffer = await buildMentoredPublicationsWorkbook(report);
  const filename = downloadFilename(program, years, report.generatedAt);

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
