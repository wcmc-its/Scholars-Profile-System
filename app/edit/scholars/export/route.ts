/**
 * GET /edit/scholars/export — CSV download of the Profiles roster (formerly
 * the standalone Data Quality dashboard's export; that surface merged into
 * `/edit/scholars`, see `lib/api/data-quality.ts`).
 *
 * Same gates, scope, and filters as the page (the query, not the UI, is the
 * boundary), but unpaginated — the full prominence-sorted set capped at
 * DATA_QUALITY_EXPORT_CAP. Filters arrive as query params (type / dept / gap /
 * hidden), matching the roster's GET form. `force-dynamic`, no-store.
 *
 * COI is gated exactly like the page (`app/edit/scholars/page.tsx`): superuser
 * only, AND only when `EDIT_DATA_QUALITY_DASHBOARD` is on — dropping the flag
 * check here (leaving only the `isSuperuser` check) would let a superuser
 * export COI through this route while the page keeps it dark, with the flag
 * off. The CSV must not carry it for anyone else either, so `gap` is forced to
 * `"all"` and `includeCoi: false` when `canSeeCoi` is false, regardless of what
 * the query string asks for — a crafted `?gap=has-coi` would otherwise leak
 * COI presence through which rows are returned even with the columns stripped.
 *
 * Gate order: no session → 401 · empty scope (a plain scholar) → 404 · else
 * text/csv attachment.
 */
import { NextResponse, type NextRequest } from "next/server";

import { buildDataQualityCsv, loadDataQualityExport, parseDataQualityParams } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isDataQualityDashboardEnabled, isEmptyScope, loadDataQualityScope } from "@/lib/edit/data-quality";

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
  const canSeeCoi = session.isSuperuser && isDataQualityDashboardEnabled();

  const { rows, total, truncated } = await loadDataQualityExport(
    {
      scope,
      query: params.q,
      roleCategories: params.roleCategories,
      units: params.units,
      gap: canSeeCoi ? params.gap : "all",
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

  const csv = buildDataQualityCsv(rows, { includeCoi: canSeeCoi });
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
