/**
 * GET /api/edit/cv/pops (scholar-CV generator, spec §6b).
 *
 * Returns the POPS (WCM physician-directory) enrichment that the CV export pulls
 * for a clinical scholar, so the `/edit` "CV (WCM format)" tool can SHOW the
 * scholar exactly which clinical credentials will be included — a transparency /
 * consent surface. The same data flows into the CV `.docx`; this read endpoint
 * exists only so it can be previewed before download.
 *
 * Target: `?cwid=` (the scholar being edited), defaulting to the effective
 * session cwid (self). A foreign target is authorized by the SAME
 * `authorizeOverviewWrite` predicate as the CV download — no drift. Flag-gated
 * behind `EDIT_CV_EXPORT` (off ⇒ 404). POPS is fetched only for `hasClinicalProfile`
 * scholars and is best-effort: any failure yields `{ pops: null }`, never a 500.
 *
 * This is `/edit`-only — POPS data is NEVER rendered on the public profile.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { isCvEnabled } from "@/lib/edit/cv-export";
import { fetchPops } from "@/lib/edit/pops";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import { editError, editOk, logEditFailure, resolveEditIdentity } from "@/lib/edit/request";

const PATH = "/api/edit/cv/pops";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Flag first — a dormant feature 404s before any session or DB work.
  if (!isCvEnabled()) return editError(404, "not_found");

  const id = await resolveEditIdentity();
  if (!id) return new NextResponse(null, { status: 401 });
  const { session, realCwid, impersonatedCwid } = id;

  const requested = new URL(request.url).searchParams.get("cwid")?.trim();
  const targetCwid = requested && requested.length > 0 ? requested : session.cwid;

  const authz = await authorizeOverviewWrite({
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
    // Only clinical faculty have a POPS record; skip the network call otherwise.
    const scholar = await db.read.scholar.findUnique({
      where: { cwid: targetCwid },
      select: { hasClinicalProfile: true },
    });
    if (!scholar) return editError(404, "scholar_not_found", "cwid");
    const pops = scholar.hasClinicalProfile ? await fetchPops(targetCwid).catch(() => null) : null;
    return editOk({ pops });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}
