/**
 * GET /api/edit/bibliometrics?cwid=&authorship=&from=&to=[&format=docx]
 *
 * One scholar's Bibliometrics report (`EDIT_BIBLIOMETRICS`, off ⇒ 404): the
 * section model as JSON for the `/edit` tab, or the same model as a Word
 * attachment with `format=docx`. Read-only; nothing is persisted.
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
import { loadBibliometricsReport } from "@/lib/edit/bibliometrics-loader";
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

  try {
    const report = await loadBibliometricsReport(targetCwid, parseBibliometricsFilters(params));
    if (!report) return editError(404, "scholar_not_found", "cwid");
    if (params.get("format") !== "docx") return editOk({ report });

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
