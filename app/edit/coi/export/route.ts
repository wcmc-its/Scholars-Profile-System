/**
 * GET /edit/coi/export — CSV download of the COI dashboard. Same gate as the
 * page: superuser + `EDIT_DATA_QUALITY_DASHBOARD` on, else 404 (never reveal
 * the surface exists). Same scope (always `{ all: true }`) and filters as the
 * page, unpaginated — the full prominence-sorted set capped at
 * DATA_QUALITY_EXPORT_CAP. `force-dynamic`, no-store.
 *
 * `gap` is sanitized to `"all" | "has-coi"` — the Profiles-only headshot/
 * overview gap values never apply here (module doc comment on
 * `lib/api/data-quality.ts`).
 */
import { NextResponse, type NextRequest } from "next/server";

import { buildDataQualityCsv, loadDataQualityExport, parseDataQualityParams } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isDataQualityDashboardEnabled } from "@/lib/edit/data-quality";

export const dynamic = "force-dynamic";
// `maxDuration` is inert under `output: "standalone"`; the real budget this route is
// bound by in prod is CloudFront's 30s origin-read timeout (`/edit*` behavior).

export async function GET(request: NextRequest) {
  const session = await getEffectiveEditSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!session.isSuperuser || !isDataQualityDashboardEnabled()) {
    return new NextResponse("Not found", { status: 404 });
  }

  const params = parseDataQualityParams(request.nextUrl.searchParams);
  const gap = params.gap === "has-coi" ? "has-coi" : "all";

  const { rows, total, truncated } = await loadDataQualityExport(
    {
      scope: { all: true },
      query: params.q,
      roleCategories: params.roleCategories,
      units: params.units,
      gap,
      includeHidden: params.includeHidden,
    },
    db.read,
  );

  console.log(
    JSON.stringify({
      event: "export_coi_roster",
      cwid: session.cwid,
      rows: rows.length,
      total,
      truncated,
      ts: new Date().toISOString(),
    }),
  );

  const csv = buildDataQualityCsv(rows, { includeProfileCols: false, includeCoi: true });
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="coi-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
