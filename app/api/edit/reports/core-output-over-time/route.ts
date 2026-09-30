/**
 * GET /api/edit/reports/core-output-over-time?center=<coreId>&kind=core[&basis=&from=&to=&evid=] —
 * report 12 (Output over time) as an `.xlsx` (Criteria, By year,
 * Publications), for the page's filters (`parseCoreOutputParams`,
 * `loadCoreOutputPubs` + `buildCoreOutput`). Gate: the page's own core gate
 * (`gateCoreReportDownload`). Publications only — no people list, no cap.
 * `center=all` (superuser only) rolls every core up: the deduped union, a
 * paper under several cores in its strongest evidence group
 * (`mergeEvidence`), and an `all-cores-…` file name.
 */
import { type NextRequest } from "next/server";

import {
  buildCoreOutput,
  buildCoreOutputWorkbook,
  loadCoreOutputPubs,
  parseCoreOutputParams,
} from "@/lib/edit/core-output-report";
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

  const now = new Date();
  const params = parseCoreOutputParams(sp, now);
  const scope = isAllCores(gate.coreId) ? await loadCoreScope(gate.coreId) : null;
  const pmids = scope?.pmids ?? (await loadCoreConfirmedPmids(gate.coreId));
  const result = buildCoreOutput(
    await loadCoreOutputPubs(gate.coreId, pmids, scope?.byCore),
    params,
  );
  const buffer = await buildCoreOutputWorkbook(
    scope ? { allCount: scope.coreIds.length } : gate.ctx.unit.name,
    params,
    result,
    now,
  );
  return xlsxResponse(
    buffer,
    coreXlsxName(
      gate.coreId,
      gate.ctx.unit.name,
      `output ${params.from}-${params.to} ${now.toISOString().slice(0, 10)}`,
    ),
  );
}
