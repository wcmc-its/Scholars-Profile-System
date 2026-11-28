/**
 * GET /api/edit/reports/translational-portfolio-scholar?cwid=… — report 26
 * for one scholar as an `.xlsx`: "Publications" (this scholar's papers in the
 * page's filters: PMID, title, journal, year, author role, stage) and
 * "Criteria". Same query string and parser as the page
 * (`parseScholarPortfolioParams`), and the page's gate
 * (`resolveScholarPortfolioAccess`): no session → 401; report 26 off, a
 * viewer `authorizeCvExport` refuses, or an unknown or hidden scholar → the
 * same 404. One scholar, so the export cap does not apply. `no-store`.
 */
import { NextResponse } from "next/server";

import {
  buildScholarPortfolioWorkbook,
  loadScholarPortfolio,
  parseScholarPortfolioParams,
  resolveScholarPortfolioAccess,
} from "@/lib/edit/translational-portfolio-scholar";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/reports/translational-portfolio-scholar";

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const cwid = sp.get("cwid")?.trim() ?? "";
  const access = await resolveScholarPortfolioAccess(cwid, PATH);
  if (access.kind === "login") return new NextResponse("Unauthorized", { status: 401 });
  if (access.kind === "denied") return new NextResponse("Not found", { status: 404 });

  const params = parseScholarPortfolioParams(sp);
  const generatedAt = new Date();
  const data = await loadScholarPortfolio(cwid, params);
  const buffer = await buildScholarPortfolioWorkbook(params, access.scholar, data, generatedAt);
  const filename = `Translational portfolio ${cwid} ${params.from}-${params.to} ${generatedAt.toISOString().slice(0, 10)}.xlsx`;

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
