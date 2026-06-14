/**
 * GET /api/edit/overview/source-options (#742 v3.1 §4 — the Sources drawer's
 * candidate lists).
 *
 * Returns a scholar's scored publications + active funding awards (and
 * `tools: []` until C3), each flagged `defaultSelected` per the shared default
 * rule so the drawer's pre-checks match the generate route's empty-selection
 * behavior.
 *
 * Target: the `?cwid=` query param (the scholar being edited), defaulting to the
 * effective session cwid (self). A FOREIGN target is authorized by the SAME
 * `authorizeOverviewWrite` predicate the generate route uses (#986) — so the
 * Sources drawer a superuser / comms_steward / proxy sees on `/edit/scholar/X`
 * reflects X's corpus, not the viewer's own, and the read/write surfaces can't
 * drift. A signed-out caller gets a `401`; an unauthorized foreign read a `403`.
 *
 * Flag-gated behind `SELF_EDIT_OVERVIEW_GENERATE` (off ⇒ 404), mirroring the
 * generate / generations routes — the picker is only meaningful once the
 * generator is live.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { loadOverviewSourceOptions } from "@/lib/edit/overview-facts";
import { isOverviewGenerateEnabled } from "@/lib/edit/overview-generator";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { editError, editOk, logEditFailure, resolveEditIdentity } from "@/lib/edit/request";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";

const PATH = "/api/edit/overview/source-options";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Flag first — a dormant feature 404s before any session or DB work.
  if (!isOverviewGenerateEnabled()) return editError(404, "not_found");

  const id = await resolveEditIdentity();
  if (!id) return new NextResponse(null, { status: 401 });
  const { session, realCwid, impersonatedCwid } = id;

  // Target defaults to self; a present `?cwid` selects a foreign read, authorized
  // by the SAME predicate as the generate WRITE (self OR superuser OR granted
  // proxy OR org-unit owner/curator). `authorizeFieldEdit` short-circuits the
  // self / superuser legs before any DB lookup, so the self case adds no cost.
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
    const options = await loadOverviewSourceOptions(targetCwid);
    return editOk(options);
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}
