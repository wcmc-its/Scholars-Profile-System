/**
 * GET /api/edit/overview/generations (#742 Phase B,
 * `docs/overview-statement-generator-spec.md` § Version history & provenance).
 *
 * Returns the SESSION user's OWN overview version history + the provenance of
 * their currently-published overview, for the `/edit` Versions panel. Self-only:
 * the cwid is derived from the session (`getEffectiveEditSession()` — the same
 * source `readEditRequest` resolves), never from a request param, so there is no
 * cross-scholar read surface and no `entityId` to validate. A signed-out caller
 * gets a `401`.
 *
 * Flag-gated behind `SELF_EDIT_OVERVIEW_GENERATE` (off ⇒ 404), mirroring the
 * generate route's dormancy — the history is only meaningful once the generator
 * is live.
 */
import { NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { isOverviewGenerateEnabled } from "@/lib/edit/overview-generator";
import {
  listOverviewGenerations,
  loadOverviewProvenance,
} from "@/lib/edit/overview-provenance";
import { editError, editOk, logEditFailure } from "@/lib/edit/request";

const PATH = "/api/edit/overview/generations";

export async function GET(): Promise<NextResponse> {
  // Flag first — a dormant feature 404s before any session or DB work (mirrors
  // the generate route).
  if (!isOverviewGenerateEnabled()) return editError(404, "not_found");

  // Self-only: the effective session cwid IS the target. No entityId param, so
  // there is no foreign read to authorize beyond "is there a session".
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse(null, { status: 401 });

  try {
    const [generations, provenance] = await Promise.all([
      listOverviewGenerations(session.cwid),
      loadOverviewProvenance(session.cwid),
    ]);
    return editOk({
      generations: generations.map((g) => ({
        id: g.id,
        model: g.model,
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
