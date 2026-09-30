/**
 * GET /edit/orcid-coverage/export — CSV of the `/edit/orcid-coverage`
 * department table (aggregates only — never a per-person list, see
 * `SCHOLAR_EXPORT_CAP`). Same `?type=&unit=&nih=` filter the page reads, parsed
 * and queried by the same functions (`parseOrcidCoverageParams`,
 * `loadOrcidCoverage`). The CSV opens with a `Filter,Value` criteria block
 * (`orcidCoverageCriteria`, the shared `personFilterCriteria` rows + NIH +
 * generated-at), one blank line, then the department table; the filename
 * carries a short filter summary. Gate order mirrors `/edit/data-sharing/export`:
 * no session → 401 · not `canViewUsage` → 404 · else text/csv attachment.
 */
import { NextResponse } from "next/server";

import { loadDataQualityFacets } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  loadOrcidCoverage,
  orcidCoverageCriteria,
  orcidCoverageExportCsv,
  orcidCoverageFilename,
  parseOrcidCoverageParams,
} from "@/lib/edit/orcid-coverage";
import { unitLabels } from "@/lib/edit/person-filter";
import { canViewUsage } from "@/lib/edit/usage-access";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  if (!(await canViewUsage(session, db.read)))
    return new NextResponse("Not found", { status: 404 });

  const params = parseOrcidCoverageParams(new URL(request.url).searchParams);
  const generatedAt = new Date();
  const [{ byDept }, labels] = await Promise.all([
    loadOrcidCoverage(db.read, params),
    // Labels only prettify the criteria block + filename; a facet-load failure
    // falls back to raw unit values (as the page captions do), not a 500.
    params.units.length > 0
      ? loadDataQualityFacets(db.read).then(unitLabels).catch(() => undefined)
      : undefined,
  ]);
  console.log(
    JSON.stringify({
      event: "export_orcid_coverage",
      cwid: session.cwid,
      ...params,
      rows: byDept.length,
    }),
  );
  const csv = orcidCoverageExportCsv(byDept, orcidCoverageCriteria(params, generatedAt, labels));
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${orcidCoverageFilename(params, generatedAt, labels)}"`,
      "Cache-Control": "no-store",
    },
  });
}
