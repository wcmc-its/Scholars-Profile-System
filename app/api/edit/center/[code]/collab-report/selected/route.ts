/**
 * GET /api/edit/center/[code]/collab-report/selected?cwid=<a>&cwid=<b>…[&c=&cmode=&x=&xmode=]
 *
 * Report 1's "Export selected": an `.xlsx` of the rows the curator ticked,
 * with the table's columns, plus a Criteria sheet. A scholar list, so the
 * server re-checks what the page already enforces (plan D1):
 *   - more than SCHOLAR_EXPORT_CAP distinct CWIDs → 422 `export_cap_exceeded`
 *     (refused, never truncated);
 *   - none → 400 `missing_cwid`;
 *   - every CWID must be one of THIS center's `CenterCollabCandidate` rows,
 *     else 400 `not_a_candidate` (no pulling arbitrary people through it).
 * The thresholds ride along only so the Criteria sheet records the view the
 * selection was made in.
 *
 * Gate: `gateCollabReportRoute`, the same as the other report 1 downloads.
 */
import { NextResponse, type NextRequest } from "next/server";

import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { loadCollabReportRows } from "@/lib/center-collaboration/collab-report-rows";
import { db } from "@/lib/db";
import { gateCollabReportRoute } from "@/lib/edit/collab-report-gate";
import { parseOptimizeParams, sortRows } from "@/lib/edit/optimize-membership-report";
import { buildOptimizeSelectedWorkbook } from "@/lib/edit/optimize-membership-xlsx";
import { editError } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/center/[code]/collab-report/selected";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;
  const gate = await gateCollabReportRoute(code, PATH);
  if (!gate.ok) return gate.response;
  const { center } = gate;

  const sp = request.nextUrl.searchParams;
  const cwids = [
    ...new Set(
      sp
        .getAll("cwid")
        .map((c) => c.trim())
        .filter(Boolean),
    ),
  ];
  if (cwids.length === 0) return editError(400, "missing_cwid", "cwid");
  if (cwids.length > SCHOLAR_EXPORT_CAP) return editError(422, "export_cap_exceeded", "cwid");

  const { rows, lastRefreshedAt } = await loadCollabReportRows(db.read, center.code);
  const byCwid = new Map(rows.map((r) => [r.cwid, r]));
  if (cwids.some((c) => !byCwid.has(c))) return editError(400, "not_a_candidate", "cwid");

  const selected = sortRows(
    cwids.map((c) => byCwid.get(c)!),
    "name",
    1,
  );
  const generatedAt = new Date();
  const buffer = await buildOptimizeSelectedWorkbook(
    selected,
    parseOptimizeParams(sp),
    center.name,
    generatedAt,
    lastRefreshedAt,
  );
  const filename = `Optimize membership selected ${center.code.replace(/[^a-zA-Z0-9_-]/g, "")} ${generatedAt.toISOString().slice(0, 10)}.xlsx`;

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
