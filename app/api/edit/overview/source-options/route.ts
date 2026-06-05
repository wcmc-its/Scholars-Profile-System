/**
 * GET /api/edit/overview/source-options (#742 v3.1 §4 — the Sources drawer's
 * candidate lists).
 *
 * Returns the SESSION user's OWN scored publications + active funding awards (and
 * `tools: []` until C3), each flagged `defaultSelected` per the shared default
 * rule so the drawer's pre-checks match the generate route's empty-selection
 * behavior. Self-only: the cwid is derived from the session
 * (`getEffectiveEditSession()`), never from a request param, so there is no
 * cross-scholar read surface and no `entityId` to validate. A signed-out caller
 * gets a `401`.
 *
 * Flag-gated behind `SELF_EDIT_OVERVIEW_GENERATE` (off ⇒ 404), mirroring the
 * generate / generations routes — the picker is only meaningful once the
 * generator is live.
 */
import { NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { loadOverviewSourceOptions } from "@/lib/edit/overview-facts";
import { isOverviewGenerateEnabled } from "@/lib/edit/overview-generator";
import { editError, editOk, logEditFailure } from "@/lib/edit/request";

const PATH = "/api/edit/overview/source-options";

export async function GET(): Promise<NextResponse> {
  // Flag first — a dormant feature 404s before any session or DB work.
  if (!isOverviewGenerateEnabled()) return editError(404, "not_found");

  // Self-only: the effective session cwid IS the target. No entityId param, so
  // there is no foreign read to authorize beyond "is there a session".
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse(null, { status: 401 });

  try {
    const options = await loadOverviewSourceOptions(session.cwid);
    return editOk(options);
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}
