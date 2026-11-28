/**
 * GET /api/edit/reports/translational-portfolio/scholars?q=&r= — report 26's
 * scholar type-ahead. Up to 8 active scholars by exact CWID or a name
 * containing `q` (`lookupScholars`), each with the link to their portfolio
 * page under the report's filters (`r`, the report's query string, parsed
 * with the report's parser), or `href: null` when this viewer cannot open it
 * (`loadBibliometricsAccess`, the same check the Scholars list's buttons use;
 * the page re-checks). Same gate as the report. `no-store`.
 */
import { NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { getPartnerEditSession } from "@/lib/auth/partner-login";
import { loadBibliometricsAccess } from "@/lib/edit/bibliometrics-access";
import {
  canViewTranslationalPortfolioReport,
  isTranslationalPortfolioReportEnabled,
  lookupScholars,
  parsePortfolioReportParams,
} from "@/lib/edit/translational-portfolio-report";
import { scholarPortfolioHref } from "@/lib/edit/translational-portfolio-scholar";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isTranslationalPortfolioReportEnabled()) return new NextResponse("Not found", { status: 404 });
  const session = (await getEffectiveEditSession()) ?? (await getPartnerEditSession());
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  if (!(await canViewTranslationalPortfolioReport(session))) return new NextResponse("Forbidden", { status: 403 });

  const sp = new URL(request.url).searchParams;
  const q = (sp.get("q") ?? "").trim().slice(0, 100);
  const report = parsePortfolioReportParams(new URLSearchParams(sp.get("r") ?? ""));
  const found = await lookupScholars(q);
  const canOpen = await loadBibliometricsAccess(found.map((s) => s.cwid));
  const matches = found.map((s) => ({
    cwid: s.cwid,
    name: s.name,
    title: s.title,
    department: s.department,
    href: canOpen.has(s.cwid) ? scholarPortfolioHref(s.cwid, report) : null,
  }));
  return NextResponse.json({ matches }, { headers: { "cache-control": "no-store" } });
}
