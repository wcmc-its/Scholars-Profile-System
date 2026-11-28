/**
 * GET /api/edit/bibliometrics?cwid=&authorship=&from=&to=[&format=docx|xlsx]
 * GET /api/edit/bibliometrics?cwid=&part=reach
 *
 * One scholar's Bibliometrics report (`EDIT_BIBLIOMETRICS`, off ⇒ 404): the
 * section model as JSON for the `/edit` tab, or the same model as a Word
 * attachment with `format=docx` or a workbook with `format=xlsx`. Read-only; nothing is persisted.
 *
 * `part=reach` answers `{ reach }` instead: the tab's "Downstream reach"
 * block, or null unless `DOWNSTREAM_REACH_REPORT` is on and the viewer can
 * open report 27 for this scholar (`loadScholarReach`), with its Connections
 * line when that view opens for this scholar (`loadScholarConnections`, run
 * beside it, so the block does not wait twice). It is its own request
 * because it depends on the scholar alone: the tab does not wait for it, and a
 * filter change does not run it again. It is scoped to the viewer, so it is
 * not part of the report model or the Word document.
 *
 * Auth + targeting mirror `GET /api/edit/cv/outline` exactly: `?cwid=` defaults
 * to the session cwid, and a foreign target is gated by the SAME
 * `authorizeCvExport` predicate (the scholar, a superuser or comms steward, a
 * granted proxy, an org-unit owner/curator, or the read-only observer role).
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { isBibliometricsEnabled, parseBibliometricsFilters } from "@/lib/edit/bibliometrics";
import { buildBibliometricsDocx } from "@/lib/edit/bibliometrics-docx";
import { loadBibliometrics, loadBibliometricsReport } from "@/lib/edit/bibliometrics-loader";
import { buildBibliometricsWorkbook, loadCitingDocRows } from "@/lib/edit/bibliometrics-xlsx";
import { patentReportHref } from "@/lib/edit/bibliometrics-patents";
import { isTranslationalPortfolioReportEnabled } from "@/lib/edit/translational-portfolio-report";
import { scholarPortfolioPath } from "@/lib/edit/translational-portfolio-scholar";
import { loadScholarConnections, loadScholarReach } from "@/lib/edit/downstream-reach-entry";
import { authorizeCvExport } from "@/lib/edit/overview-authz";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { editError, editOk, logEditFailure, resolveEditIdentity } from "@/lib/edit/request";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";

const PATH = "/api/edit/bibliometrics";

export async function GET(request: NextRequest): Promise<Response> {
  // Flag first — a dormant feature 404s before any session or DB work.
  if (!isBibliometricsEnabled()) return editError(404, "not_found");

  const id = await resolveEditIdentity();
  if (!id) return new NextResponse(null, { status: 401 });
  const { session, realCwid, impersonatedCwid } = id;

  const params = new URL(request.url).searchParams;
  const requested = params.get("cwid")?.trim();
  const targetCwid = requested && requested.length > 0 ? requested : session.cwid;

  const authz = await authorizeCvExport({
    session,
    realCwid,
    impersonatedCwid,
    entityId: targetCwid,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({ actorCwid: session.cwid, targetCwid, path: PATH, reason: authz.reason });
    return editError(403, authz.reason);
  }

  if (params.get("part") === "reach") {
    // A door into another report: its failure leaves the tab without the block,
    // and the Connections line's failure leaves the block without that line.
    const failed = (err: unknown) => {
      logEditFailure(PATH, err);
      return null;
    };
    const [reach, connections] = await Promise.all([
      loadScholarReach(targetCwid, session).catch(failed),
      loadScholarConnections(targetCwid, session).catch(failed),
    ]);
    return editOk({ reach: reach && connections ? { ...reach, connections } : reach });
  }

  try {
    if (params.get("format") === "xlsx") {
      const loaded = await loadBibliometrics(targetCwid, parseBibliometricsFilters(params));
      if (!loaded) return editError(404, "scholar_not_found", "cwid");
      const citing = await loadCitingDocRows(loaded.articles.map((p) => p.pmid));
      const buffer = await buildBibliometricsWorkbook(loaded.report, loaded.articles, citing);
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="bibliometrics-${targetCwid}-${loaded.report.asOf}.xlsx"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const report = await loadBibliometricsReport(targetCwid, parseBibliometricsFilters(params));
    if (!report) return editError(404, "scholar_not_found", "cwid");
    if (params.get("format") !== "docx") {
      // The link to report 25, only for a viewer who may open it.
      if (report.patents.papers > 0) report.patents.reportHref = await patentReportHref(session, targetCwid);
      // The link to this scholar's translational portfolio page, whose gate is
      // report 26 on plus the same `authorizeCvExport` this request passed.
      if (report.stages && isTranslationalPortfolioReportEnabled()) {
        report.stages.portfolioHref = scholarPortfolioPath(targetCwid);
      }
      return editOk({ report });
    }

    const buffer = await buildBibliometricsDocx(report);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="bibliometrics-${targetCwid}.docx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}
