/**
 * GET /api/edit/center/[code]/collab-pub-matrix/xlsx[?from=&to=&type=&exclude=&confirmed=]
 *
 * Report 19 ("Collaborative publication matrix") as an `.xlsx` for the
 * page's params (`parseCollabPubMatrixParams`, the parser the page uses):
 * EVAL's "Publication Data" and "Report Details" sheets
 * (`lib/edit/collab-pub-matrix-xlsx.ts`). Counts only, no people.
 *
 * Gate: `gateCollabReportRoute` (signed in, center exists, `canEditUnit`),
 * the same gate as report 1's downloads.
 */
import { NextResponse, type NextRequest } from "next/server";

import { parseCollabPubMatrixParams } from "@/lib/edit/collab-pub-matrix";
import { loadCollabPubMatrix } from "@/lib/edit/collab-pub-matrix.server";
import { buildCollabPubMatrixWorkbook } from "@/lib/edit/collab-pub-matrix-xlsx";
import { gateCollabReportRoute } from "@/lib/edit/collab-report-gate";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/center/[code]/collab-pub-matrix/xlsx";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;
  const gate = await gateCollabReportRoute(code, PATH);
  if (!gate.ok) return gate.response;
  const { center } = gate;

  const p = parseCollabPubMatrixParams(request.nextUrl.searchParams);
  const runDate = new Date();
  const buffer = await buildCollabPubMatrixWorkbook(
    await loadCollabPubMatrix(center.code, p),
    p,
    runDate,
  );
  const filename = `Collaborative publication matrix ${center.code.replace(/[^a-zA-Z0-9_-]/g, "")} ${runDate.toISOString().slice(0, 10)}.xlsx`;

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
