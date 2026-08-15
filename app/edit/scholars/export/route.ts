/**
 * GET /edit/scholars/export — CSV download of the Profiles roster (formerly
 * the standalone Data Quality dashboard's export; that surface merged into
 * `/edit/scholars`, see `lib/api/data-quality.ts`).
 *
 * Same gates, scope, and filters as the page (the query, not the UI, is the
 * boundary), but unpaginated — the full prominence-sorted set capped at
 * DATA_QUALITY_EXPORT_CAP. Filters arrive as query params (type / dept / gap /
 * overviewAge / hidden), matching the roster's GET form. `force-dynamic`,
 * no-store.
 *
 * COI never appears here — it's superuser-only and lives on its own export
 * (`/edit/coi/export`). `gap` is forced to strip `"has-coi"` (falling back to
 * `"all"`), same as the page: a crafted `?gap=has-coi` would otherwise narrow
 * the row set by COI presence in a CSV that never carries the column.
 *
 * Gate order: no session → 401 · empty scope (a plain scholar) → 404 · else
 * text/csv attachment.
 */
import { NextResponse, type NextRequest } from "next/server";

import { buildDataQualityCsv, loadDataQualityExport, parseDataQualityParams } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isEmptyScope, loadDataQualityScope } from "@/lib/edit/data-quality";

export const dynamic = "force-dynamic";
// `maxDuration` is inert under `output: "standalone"`; the real budget this route is
// bound by in prod is CloudFront's 30s origin-read timeout (`/edit*` behavior).

export async function GET(request: NextRequest) {
  const session = await getEffectiveEditSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const scope = await loadDataQualityScope(session, db.read);
  if (isEmptyScope(scope)) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Identical parse to the page (the query, not the UI, is the boundary).
  const params = parseDataQualityParams(request.nextUrl.searchParams);
  const gap = params.gap === "has-coi" ? "all" : params.gap;

  const { rows, total, truncated } = await loadDataQualityExport(
    {
      scope,
      query: params.q,
      roleCategories: params.roleCategories,
      units: params.units,
      gap,
      overviewAge: params.overviewAge,
      includeHidden: params.includeHidden,
    },
    db.read,
  );

  console.log(
    JSON.stringify({
      event: "export_profiles_roster",
      cwid: session.cwid,
      scope: scope.all ? "all" : "units",
      rows: rows.length,
      total,
      truncated,
      ts: new Date().toISOString(),
    }),
  );

  const csv = buildDataQualityCsv(rows, { includeProfileCols: true, includeCoi: false });
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="profiles-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
