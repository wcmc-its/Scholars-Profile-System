/**
 * GET /api/edit/reports/high-impact-publications — report 9 as an `.xlsx`
 * (Publications, Summary, Criteria). Same query string as the page
 * (`parseHighImpactParams`), same gate (a `report_access` row on
 * `HIGH_IMPACT_PUBS_REPORT`; superuser / comms_steward always).
 */
import { NextResponse } from "next/server";

import { loadDataQualityFacets } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { unitLabels } from "@/lib/edit/article-count-report";
import {
  buildHighImpactWorkbook,
  HIGH_IMPACT_LIST_CAP,
  loadHighImpactList,
  loadJournalCounts,
  parseHighImpactParams,
} from "@/lib/edit/high-impact-pubs-report";
import { getReportScopes, HIGH_IMPACT_PUBS_REPORT } from "@/lib/edit/report-access";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  if ((await getReportScopes(session, HIGH_IMPACT_PUBS_REPORT)).size === 0) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const params = parseHighImpactParams(new URL(request.url).searchParams);
  const generatedAt = new Date();
  const counts = await loadJournalCounts(params);
  const total = counts.reduce((s, c) => s + c.count, 0);
  const list = total <= HIGH_IMPACT_LIST_CAP ? await loadHighImpactList(params) : null;
  const labels = params.units.length > 0 ? unitLabels(await loadDataQualityFacets(db.read)) : undefined;
  const buffer = await buildHighImpactWorkbook(params, counts, list, generatedAt, labels);
  const filename = `High-impact publications ${params.from}-${params.to} ${generatedAt.toISOString().slice(0, 10)}.xlsx`;

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
