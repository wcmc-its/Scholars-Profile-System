/**
 * GET /edit/data-quality/export — CSV download of the Data Quality dashboard
 * (docs/data-quality-dashboard-spec.md §10).
 *
 * Same gates, scope, and filters as the page (the query, not the UI, is the
 * boundary), but unpaginated — the full prominence-sorted set capped at
 * DATA_QUALITY_EXPORT_CAP. Filters arrive as query params (type / dept / gap /
 * hidden), matching the dashboard's GET form. `force-dynamic`, no-store.
 *
 * Gate order: flag off → 404 · no session → 401 · empty scope (a plain scholar)
 * → 404 · else text/csv attachment.
 */
import { NextResponse, type NextRequest } from "next/server";

import {
  buildDataQualityCsv,
  loadDataQualityExport,
  type DataQualityGapFilter,
} from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  isDataQualityDashboardEnabled,
  isEmptyScope,
  loadDataQualityScope,
} from "@/lib/edit/data-quality";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function parseGap(v: string | null): DataQualityGapFilter {
  return v === "no-headshot" || v === "no-overview" || v === "has-coi" ? v : "all";
}

export async function GET(request: NextRequest) {
  if (!isDataQualityDashboardEnabled()) {
    return new NextResponse("Not found", { status: 404 });
  }
  const session = await getEffectiveEditSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const scope = await loadDataQualityScope(session, db.read);
  if (isEmptyScope(scope)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const sp = request.nextUrl.searchParams;
  const roleCategory = (sp.get("type") ?? "").trim() || undefined;
  const deptCode = (sp.get("dept") ?? "").trim() || undefined;
  const gap = parseGap(sp.get("gap"));
  const hidden = sp.get("hidden");
  const includeHidden = !(hidden === "0" || hidden === "false");

  const { rows, total, truncated } = await loadDataQualityExport(
    { scope, roleCategory, deptCode, gap, includeHidden },
    db.read,
  );

  console.log(
    JSON.stringify({
      event: "export_data_quality",
      cwid: session.cwid,
      scope: scope.all ? "all" : "units",
      rows: rows.length,
      total,
      truncated,
      ts: new Date().toISOString(),
    }),
  );

  const csv = buildDataQualityCsv(rows);
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="data-quality-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
