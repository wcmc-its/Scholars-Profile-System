/**
 * GET /api/edit/center/[code]/fk-awards/xlsx[?from=&to=&asOf=&labOnly=]
 *
 * Report 21 ("F and K awards") as an `.xlsx` for the page's params
 * (`parseFkAwardsParams`, the parser the page uses).
 *
 * Gate: `gateCollabReportRoute` (signed in, center exists, `canEditUnit`),
 * the same gate as reports 1 and 19's downloads.
 */
import { NextResponse, type NextRequest } from "next/server";

import { gateCollabReportRoute } from "@/lib/edit/collab-report-gate";
import { parseFkAwardsParams } from "@/lib/edit/fk-awards";
import { loadFkAwards } from "@/lib/edit/fk-awards.server";
import { buildFkAwardsWorkbook } from "@/lib/edit/fk-awards-xlsx";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/center/[code]/fk-awards/xlsx";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;
  const gate = await gateCollabReportRoute(code, PATH);
  if (!gate.ok) return gate.response;
  const { center } = gate;

  const p = parseFkAwardsParams(request.nextUrl.searchParams);
  const runDate = new Date();
  const buffer = await buildFkAwardsWorkbook(
    await loadFkAwards(center.code, p),
    p,
    center.name,
    runDate,
  );
  const filename = `F and K awards ${center.code.replace(/[^a-zA-Z0-9_-]/g, "")} ${runDate.toISOString().slice(0, 10)}.xlsx`;

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
