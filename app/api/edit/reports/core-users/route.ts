/**
 * GET /api/edit/reports/core-users?center=<coreId>&kind=core[&type=&unit=&client=&minp=&from=&to=] —
 * report 11 (Core users) as an `.xlsx` (Criteria, People, Departments), for
 * the page's filters (`parseCoreUsersParams`, `loadCoreUsersReport`).
 *
 * Gate: the page's own core gate (`gateCoreReportDownload` →
 * `loadReportsContext(…, "core")`). A list of people, so `SCHOLAR_EXPORT_CAP`
 * applies: above it the download is REFUSED (409, no file) — never truncated.
 * The page shows why instead of the button. `center=all` (superuser only):
 * the deduped union over every core, known clients of any core, and the same
 * cap.
 */
import { type NextRequest } from "next/server";

import {
  coreXlsxName,
  gateCoreReportDownload,
  isAllCores,
  loadCoreConfirmedPmids,
  loadCoreScope,
  xlsxResponse,
} from "@/lib/edit/core-report-common";
import {
  buildCoreUsersWorkbook,
  coreUsersExportAllowed,
  loadCoreUsersReport,
  parseCoreUsersParams,
} from "@/lib/edit/core-users-report";
import { editError } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const gate = await gateCoreReportDownload(sp);
  if (!gate.ok) return gate.response;

  const params = parseCoreUsersParams(sp);
  const scope = isAllCores(gate.coreId) ? await loadCoreScope(gate.coreId) : null;
  const result = await loadCoreUsersReport(
    gate.coreId,
    scope?.pmids ?? (await loadCoreConfirmedPmids(gate.coreId)),
    params,
  );
  if (!coreUsersExportAllowed(result.people.length))
    return editError(409, "over_scholar_export_cap");

  const generatedAt = new Date();
  const buffer = await buildCoreUsersWorkbook(
    scope ? { allCount: scope.coreIds.length } : gate.ctx.unit.name,
    params,
    result,
    generatedAt,
  );
  return xlsxResponse(
    buffer,
    coreXlsxName(
      gate.coreId,
      gate.ctx.unit.name,
      `core users ${generatedAt.toISOString().slice(0, 10)}`,
    ),
  );
}
