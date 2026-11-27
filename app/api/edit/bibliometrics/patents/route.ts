/**
 * GET /api/edit/bibliometrics/patents?cwid=
 *
 * Every patent citing one scholar's publications, as an `.xlsx`: Citations
 * (one row per paper and invention), Publications, Inventions, Criteria. The
 * Bibliometrics tab's "Download patents citing this work (Excel)".
 *
 * Flag, auth and targeting are `GET /api/edit/bibliometrics`'s exactly:
 * `EDIT_BIBLIOMETRICS` off ⇒ 404, `?cwid=` defaults to the session cwid, and
 * the target is gated by `authorizeCvExport`, so a scholar can download their
 * own. One scholar's own publications and no other people: the 50-scholar
 * export cap does not apply. Read-only; `no-store`.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { isBibliometricsEnabled } from "@/lib/edit/bibliometrics";
import { buildScholarPatentWorkbook, loadScholarPatentCitations } from "@/lib/edit/bibliometrics-patents";
import { authorizeCvExport } from "@/lib/edit/overview-authz";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { editError, logEditFailure, resolveEditIdentity } from "@/lib/edit/request";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";

const PATH = "/api/edit/bibliometrics/patents";

export async function GET(request: NextRequest): Promise<Response> {
  // Flag first — a dormant feature 404s before any session or DB work.
  if (!isBibliometricsEnabled()) return editError(404, "not_found");

  const id = await resolveEditIdentity();
  if (!id) return new NextResponse(null, { status: 401 });
  const { session, realCwid, impersonatedCwid } = id;

  const requested = new URL(request.url).searchParams.get("cwid")?.trim();
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
    const data = await loadScholarPatentCitations(targetCwid);
    if (!data) return editError(404, "scholar_not_found", "cwid");

    const buffer = await buildScholarPatentWorkbook(data, new Date());
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="patents-citing-${targetCwid}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}
