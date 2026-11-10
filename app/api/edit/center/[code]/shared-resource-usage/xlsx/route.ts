/**
 * GET /api/edit/center/[code]/shared-resource-usage/xlsx[?quarter=&core=]
 *
 * Report 20 ("Shared resource usage"): the subsidy-by-lab table as an `.xlsx`
 * for the page's params (`parseSharedResourceParams`, the parser the page
 * uses), built by `buildSharedResourceWorkbook`.
 *
 * Gate: `gateCollabReportRoute` (signed in, center exists, `canEditUnit`),
 * the same gate as report 1's and 19's downloads.
 */
import { NextResponse, type NextRequest } from "next/server";

import { gateCollabReportRoute } from "@/lib/edit/collab-report-gate";
import { parseSharedResourceParams } from "@/lib/edit/shared-resource-usage";
import { loadSharedResourceUsage } from "@/lib/edit/shared-resource-usage.server";
import { buildSharedResourceWorkbook } from "@/lib/edit/shared-resource-usage-xlsx";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/center/[code]/shared-resource-usage/xlsx";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;
  const gate = await gateCollabReportRoute(code, PATH);
  if (!gate.ok) return gate.response;
  const { center } = gate;

  const p = parseSharedResourceParams(request.nextUrl.searchParams);
  const r = await loadSharedResourceUsage(center.code, p, { papers: false });
  const labs = (r.usage?.labs ?? []).filter((l) => !p.core || l.coreName === p.core);
  const buffer = await buildSharedResourceWorkbook(center.name, r.quarter, labs, p);
  const filename = `Shared resource usage ${center.code.replace(/[^a-zA-Z0-9_-]/g, "")} ${r.quarter?.key ?? "none"}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(buffer.byteLength),
      "cache-control": "no-store",
    },
  });
}
