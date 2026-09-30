/**
 * GET /api/edit/reports/core-grants?center=<coreId>&kind=core[&status=&funder=&mech=] —
 * report 13 (Grants citing the core) as an `.xlsx` (Criteria, Grants, By
 * funder), for the page's filters (`parseCoreGrantsParams`,
 * `loadCoreGrantAwards` + `filterAwards`). Gate: the page's own core gate
 * (`gateCoreReportDownload`). One row per award with its PI as a column — not
 * a scholar list, so no `SCHOLAR_EXPORT_CAP`. `center=all` (superuser only):
 * the grants of the deduped union over every core.
 */
import { type NextRequest } from "next/server";

import {
  buildCoreGrantsWorkbook,
  filterAwards,
  loadCoreGrantAwards,
  parseCoreGrantsParams,
} from "@/lib/edit/core-grants-report";
import {
  coreXlsxName,
  gateCoreReportDownload,
  isAllCores,
  loadCoreConfirmedPmids,
  loadCoreScope,
  xlsxResponse,
} from "@/lib/edit/core-report-common";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const gate = await gateCoreReportDownload(sp);
  if (!gate.ok) return gate.response;

  const params = parseCoreGrantsParams(sp);
  const generatedAt = new Date();
  const asOf = generatedAt.toISOString().slice(0, 10);
  const scope = isAllCores(gate.coreId) ? await loadCoreScope(gate.coreId) : null;
  const { awards, pmidsByKey } = await loadCoreGrantAwards(
    scope?.pmids ?? (await loadCoreConfirmedPmids(gate.coreId)),
    asOf,
  );
  const result = filterAwards(awards, params, pmidsByKey);
  const buffer = await buildCoreGrantsWorkbook(
    scope ? { allCount: scope.coreIds.length } : gate.ctx.unit.name,
    params,
    result,
    asOf,
    generatedAt,
  );
  return xlsxResponse(buffer, coreXlsxName(gate.coreId, gate.ctx.unit.name, `grants ${asOf}`));
}
