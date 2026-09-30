/**
 * GET /api/edit/center/[code]/collab-report/xlsx[?c=&cmode=&x=&xmode=&q=&inst=]
 *
 * Report 1 ("Optimize membership") as an `.xlsx`: one sheet per list for the
 * page's thresholds and filters (`parseOptimizeParams`, the same parser the
 * page uses), then a Criteria sheet. A list of more than SCHOLAR_EXPORT_CAP
 * people is withheld, with a note in its place; never truncated
 * (`lib/edit/optimize-membership-xlsx.ts`, plan D1). This replaces the
 * retired whole-report CSV.
 *
 * Gate: `gateCollabReportRoute` (signed in, center exists, `canEditUnit`),
 * the same gate as the per-person CSV (`../export?cwid=`).
 */
import { NextResponse, type NextRequest } from "next/server";

import { loadCollabReportRows } from "@/lib/center-collaboration/collab-report-rows";
import { db } from "@/lib/db";
import { gateCollabReportRoute } from "@/lib/edit/collab-report-gate";
import { bucketLists, parseOptimizeParams } from "@/lib/edit/optimize-membership-report";
import { buildOptimizeMembershipWorkbook } from "@/lib/edit/optimize-membership-xlsx";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/center/[code]/collab-report/xlsx";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;
  const gate = await gateCollabReportRoute(code, PATH);
  if (!gate.ok) return gate.response;
  const { center } = gate;

  const p = parseOptimizeParams(request.nextUrl.searchParams);
  const { rows, lastRefreshedAt } = await loadCollabReportRows(db.read, center.code);
  const generatedAt = new Date();
  const buffer = await buildOptimizeMembershipWorkbook(
    bucketLists(rows, p),
    p,
    center.name,
    generatedAt,
    lastRefreshedAt,
  );
  const filename = `Optimize membership ${center.code.replace(/[^a-zA-Z0-9_-]/g, "")} ${generatedAt.toISOString().slice(0, 10)}.xlsx`;

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
