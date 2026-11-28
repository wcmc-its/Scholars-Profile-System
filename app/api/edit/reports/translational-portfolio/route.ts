/**
 * GET /api/edit/reports/translational-portfolio — report 26 (Translational
 * portfolio) as an `.xlsx`: "By year" (each year's publications by stage),
 * the page's current table tab (department / division / center / research
 * area, with the All of WCM baseline), "Scholars" (the Scholars list, only at
 * or under `SCHOLAR_EXPORT_CAP`; above it the sheet says so and lists no one)
 * and "Criteria". Same query string and parser as the page
 * (`parsePortfolioReportParams`, which ignores `cwid`: one scholar is their
 * own page, behind `authorizeCvExport`), same gate
 * (`canViewTranslationalPortfolioReport`).
 * Flag off → 404 · no session → 401 · not an administrator → 403. `no-store`.
 */
import { NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { getPartnerEditSession } from "@/lib/auth/partner-login";
import {
  buildPortfolioWorkbook,
  canViewTranslationalPortfolioReport,
  isTranslationalPortfolioReportEnabled,
  loadPortfolio,
  loadPortfolioChoices,
  parsePortfolioReportParams,
} from "@/lib/edit/translational-portfolio-report";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isTranslationalPortfolioReportEnabled()) return new NextResponse("Not found", { status: 404 });
  const session = (await getEffectiveEditSession()) ?? (await getPartnerEditSession());
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  if (!(await canViewTranslationalPortfolioReport(session))) return new NextResponse("Forbidden", { status: 403 });

  // Never one scholar: report 26's gate is wider than the scholar page's
  // (`authorizeCvExport`), so `?cwid=` is ignored here, as on the page.
  const params = parsePortfolioReportParams(new URL(request.url).searchParams);
  const generatedAt = new Date();
  const choices = await loadPortfolioChoices();
  const data = await loadPortfolio(params, choices, { forExport: true });
  const buffer = await buildPortfolioWorkbook(params, choices, data, generatedAt);
  const filename = `Translational portfolio ${params.from}-${params.to} ${generatedAt.toISOString().slice(0, 10)}.xlsx`;

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
