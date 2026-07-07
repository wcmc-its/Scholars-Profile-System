/**
 * GET / PUT /api/edit/overview/selection (#742 spec §2.5 — the durable three-state
 * source-selection deltas).
 *
 * GET returns the scholar's saved `OverviewSelectionDeltas` (or the default empty
 * deltas when none exist); PUT upserts them. Both target the `?cwid=` query param
 * (defaulting to the effective session cwid) and are authorized by the SAME
 * `authorizeOverviewWrite` predicate as the generate / source-options routes, so a
 * superuser / comms_steward / proxy edits the target scholar's deltas, never their
 * own. A signed-out caller gets 401; an unauthorized foreign target 403.
 *
 * Flag-gated behind `SELF_EDIT_OVERVIEW_GENERATE` (off ⇒ 404), mirroring the other
 * overview routes.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial, verifyRequestOrigin } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { isOverviewGenerateEnabled } from "@/lib/edit/overview-generator";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import {
  editError,
  editOk,
  impersonationReadonly,
  logEditFailure,
  resolveEditIdentity,
} from "@/lib/edit/request";
import {
  loadOverviewSelectionDeltas,
  saveOverviewSelectionDeltas,
} from "@/lib/edit/overview-selection-store";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";

const PATH = "/api/edit/overview/selection";

/** Resolve the authorized target cwid for the request, or a NextResponse to
 *  return early (401 / 403 / 404). Shared by GET + PUT. */
async function authorizeTarget(
  request: NextRequest,
): Promise<
  { targetCwid: string; actorCwid: string; impersonatedCwid: string | null } | NextResponse
> {
  if (!isOverviewGenerateEnabled()) return editError(404, "not_found");

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
  return { targetCwid, actorCwid: session.cwid, impersonatedCwid };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authorizeTarget(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const deltas = await loadOverviewSelectionDeltas(auth.targetCwid);
    return editOk({ deltas });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  // This route reads its body via `request.json()` instead of `readEditRequest`,
  // so the write-path guards every sibling gets for free are owed explicitly:
  // the R4 same-origin + JSON content-type CSRF defense, and the R3
  // impersonation-readonly refusal before any mutation.
  const origin = verifyRequestOrigin(request);
  if (!origin.ok) {
    return editError(origin.reason === "bad_content_type" ? 415 : 403, origin.reason);
  }
  const auth = await authorizeTarget(request);
  if (auth instanceof NextResponse) return auth;
  if (auth.impersonatedCwid !== null && impersonationReadonly()) {
    return editError(403, "impersonation_readonly");
  }
  // Untrusted body — `saveOverviewSelectionDeltas` normalizes before persisting, so
  // a malformed / oversized payload is coerced rather than rejected.
  const body = await request.json().catch(() => ({}));
  try {
    const deltas = await saveOverviewSelectionDeltas(
      auth.targetCwid,
      auth.actorCwid,
      (body as { deltas?: unknown })?.deltas,
    );
    return editOk({ deltas });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }
}
