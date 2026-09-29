/**
 * GET /api/edit/reports/core-output-over-time?center=<coreId>&kind=core[&basis=&from=&to=&evid=] —
 * report 12 (Output over time) as an `.xlsx` (Criteria, By year,
 * Publications), for the page's filters (`parseCoreOutputParams`,
 * `loadCoreOutputPubs` + `buildCoreOutput`). Gate: the page's own core gate
 * (`gateCoreReportDownload`). Publications only — no people list, no cap.
 */
import { type NextRequest } from "next/server";

import {
  buildCoreOutput,
  buildCoreOutputWorkbook,
  loadCoreOutputPubs,
  parseCoreOutputParams,
} from "@/lib/edit/core-output-report";
import {
  fileSafe,
  gateCoreReportDownload,
  loadCoreConfirmedPmids,
  xlsxResponse,
} from "@/lib/edit/core-report-common";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const gate = await gateCoreReportDownload(sp);
  if (!gate.ok) return gate.response;

  const now = new Date();
  const params = parseCoreOutputParams(sp, now);
  const pmids = await loadCoreConfirmedPmids(gate.coreId);
  const result = buildCoreOutput(await loadCoreOutputPubs(gate.coreId, pmids), params);
  const buffer = await buildCoreOutputWorkbook(gate.ctx.unit.name, params, result, now);
  return xlsxResponse(
    buffer,
    `${fileSafe(gate.ctx.unit.name)} output ${params.from}-${params.to} ${now.toISOString().slice(0, 10)}.xlsx`,
  );
}
