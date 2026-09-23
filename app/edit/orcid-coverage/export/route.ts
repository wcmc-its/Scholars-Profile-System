/**
 * GET /edit/orcid-coverage/export — CSV of the `/edit/orcid-coverage`
 * department table (aggregates only — never a per-person list, see
 * `SCHOLAR_EXPORT_CAP`). Same `?type=&unit=&nih=` filter the page reads, parsed
 * and queried by the same functions (`parseOrcidCoverageParams`,
 * `loadOrcidCoverage`). The CSV has no criteria header — the link carries the
 * page's own query string. Gate order mirrors `/edit/data-sharing/export`:
 * no session → 401 · not `canViewUsage` → 404 · else text/csv attachment.
 */
import { NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  loadOrcidCoverage,
  orcidCoverageCsv,
  parseOrcidCoverageParams,
} from "@/lib/edit/orcid-coverage";
import { canViewUsage } from "@/lib/edit/usage-access";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  if (!(await canViewUsage(session, db.read)))
    return new NextResponse("Not found", { status: 404 });

  const params = parseOrcidCoverageParams(new URL(request.url).searchParams);
  const { byDept } = await loadOrcidCoverage(db.read, params);
  console.log(
    JSON.stringify({
      event: "export_orcid_coverage",
      cwid: session.cwid,
      ...params,
      rows: byDept.length,
    }),
  );
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(orcidCoverageCsv(byDept), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orcid-coverage-by-department-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
