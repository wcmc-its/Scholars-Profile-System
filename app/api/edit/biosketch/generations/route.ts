/**
 * GET /api/edit/biosketch/generations (#917 v6, handoff §6).
 *
 * Returns a scholar's biosketch generation history for the `/edit` "Earlier biosketches"
 * panel. Unlike the overview, the biosketch has no save-to-profile flow, so there is NO
 * provenance half — just the list of prior generations (newest first, capped).
 *
 * Target: the `?cwid=` query param (the scholar being edited), defaulting to the effective
 * session cwid (self). A FOREIGN target is authorized by the SAME `authorizeOverviewWrite`
 * predicate the generate route uses. A signed-out caller gets a `401`; an unauthorized
 * foreign read a `403`. Flag-gated behind `EDIT_BIOSKETCH_GENERATE` (off ⇒ 404), mirroring
 * the generate route's dormancy.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { isBiosketchGenerateEnabled } from "@/lib/edit/biosketch-generator";
import { listBiosketchGenerations } from "@/lib/edit/biosketch-provenance";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { editError, editOk, logEditFailure, resolveEditIdentity } from "@/lib/edit/request";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";

const PATH = "/api/edit/biosketch/generations";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Flag first — a dormant feature 404s before any session or DB work.
  if (!isBiosketchGenerateEnabled()) return editError(404, "not_found");

  const id = await resolveEditIdentity();
  if (!id) return new NextResponse(null, { status: 401 });
  const { session, realCwid, impersonatedCwid } = id;

  // Target defaults to self; a present `?cwid` selects a foreign read, authorized by the
  // SAME predicate as the generate WRITE (no drift).
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
    const generations = await listBiosketchGenerations(targetCwid);
    return editOk({
      generations: generations.map((g) => ({
        id: g.id,
        mode: g.mode,
        entries: g.entries,
        projectTitle: g.projectTitle,
        projectAims: g.projectAims,
        model: g.model,
        promptVersion: g.promptVersion,
        params: g.params,
        products: g.products,
        sources: g.sources,
        createdAt: g.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}
