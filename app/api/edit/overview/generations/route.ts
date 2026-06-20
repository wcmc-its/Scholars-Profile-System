/**
 * GET /api/edit/overview/generations (#742 Phase B,
 * `docs/overview-statement-generator-spec.md` § Version history & provenance).
 *
 * Returns a scholar's overview version history + the provenance of their
 * currently-published overview, for the `/edit` Versions panel.
 *
 * Target: the `?cwid=` query param (the scholar being edited), defaulting to the
 * effective session cwid (self). A FOREIGN target is authorized by the SAME
 * `authorizeOverviewWrite` predicate the generate route uses (#986) — so the
 * "Earlier drafts" / provenance a superuser sees on `/edit/scholar/X` reflects
 * X's history, not the viewer's own. A signed-out caller gets a `401`; an
 * unauthorized foreign read a `403`.
 *
 * Flag-gated behind `SELF_EDIT_OVERVIEW_GENERATE` (off ⇒ 404), mirroring the
 * generate route's dormancy — the history is only meaningful once the generator
 * is live.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { isOverviewGenerateEnabled } from "@/lib/edit/overview-generator";
import {
  listOverviewGenerations,
  loadOverviewProvenance,
} from "@/lib/edit/overview-provenance";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { editError, editOk, logEditFailure, resolveEditIdentity } from "@/lib/edit/request";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";

const PATH = "/api/edit/overview/generations";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Flag first — a dormant feature 404s before any session or DB work (mirrors
  // the generate route).
  if (!isOverviewGenerateEnabled()) return editError(404, "not_found");

  const id = await resolveEditIdentity();
  if (!id) return new NextResponse(null, { status: 401 });
  const { session, realCwid, impersonatedCwid } = id;

  // Target defaults to self; a present `?cwid` selects a foreign read, authorized
  // by the SAME predicate as the generate WRITE (no drift). `authorizeFieldEdit`
  // short-circuits the self / superuser legs before any DB lookup.
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
    const [generations, provenance] = await Promise.all([
      listOverviewGenerations(targetCwid),
      loadOverviewProvenance(targetCwid),
    ]);
    return editOk({
      generations: generations.map((g) => ({
        id: g.id,
        model: g.model,
        promptVersion: g.promptVersion,
        params: g.params,
        createdAt: g.createdAt.toISOString(),
        text: g.text,
      })),
      provenance: provenance
        ? {
            origin: provenance.origin,
            model: provenance.model,
            sourceGenerationId: provenance.sourceGenerationId,
            updatedAt: provenance.updatedAt.toISOString(),
          }
        : null,
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}
