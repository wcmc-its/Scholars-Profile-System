/**
 * /api/edit/overview/history — the Overview History panel's row actions.
 *
 *   PATCH  { kind: "draft", id, name }   — rename a draft ("" clears the name
 *                                          back to the default "AI draft N").
 *   DELETE { kind: "draft" | "version", id } — hide a draft or a saved version
 *                                          from the panel.
 *
 * Deletes are SOFT (`hidden_at`): the row stays for the audit / A-B trail, it
 * just drops out of `GET /api/edit/overview/generations`. The newest saved
 * version is the live overview and cannot be hidden (409 `live_version`).
 *
 * Target + authz mirror the sibling overview routes: `?cwid=` (default self),
 * authorized by `authorizeOverviewWrite`; flag-gated behind
 * `SELF_EDIT_OVERVIEW_GENERATE`; same-origin JSON CSRF check and the
 * impersonation-readonly refusal before any write. A row that is not the
 * target scholar's is a 404, never a cross-scholar write.
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
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";

const PATH = "/api/edit/overview/history";

/** Matches the `overview_generation.name` column. */
const OVERVIEW_DRAFT_NAME_MAX = 40;

type Body = { kind?: unknown; id?: unknown; name?: unknown };

async function authorizeWrite(
  request: NextRequest,
): Promise<{ targetCwid: string; body: Body } | NextResponse> {
  const origin = verifyRequestOrigin(request);
  if (!origin.ok) {
    return editError(origin.reason === "bad_content_type" ? 415 : 403, origin.reason);
  }
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
  if (impersonatedCwid !== null && impersonationReadonly()) {
    return editError(403, "impersonation_readonly");
  }
  const body = ((await request.json().catch(() => null)) ?? {}) as Body;
  return { targetCwid, body };
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const auth = await authorizeWrite(request);
  if (auth instanceof NextResponse) return auth;
  const { targetCwid, body } = auth;
  if (body.kind !== "draft" || typeof body.id !== "string" || typeof body.name !== "string") {
    return editError(400, "invalid_request");
  }
  const name = body.name.trim().slice(0, OVERVIEW_DRAFT_NAME_MAX);
  try {
    // `updateMany` scoped by cwid: a foreign or hidden id matches no row → 404.
    const res = await db.write.overviewGeneration.updateMany({
      where: { id: body.id, cwid: targetCwid, hiddenAt: null },
      data: { name: name === "" ? null : name },
    });
    if (res.count === 0) return editError(404, "not_found");
    return editOk({ id: body.id, name: name === "" ? null : name });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = await authorizeWrite(request);
  if (auth instanceof NextResponse) return auth;
  const { targetCwid, body } = auth;
  if ((body.kind !== "draft" && body.kind !== "version") || typeof body.id !== "string") {
    return editError(400, "invalid_request");
  }
  const where = { id: body.id, cwid: targetCwid, hiddenAt: null };
  const data = { hiddenAt: new Date() };
  try {
    if (body.kind === "draft") {
      const res = await db.write.overviewGeneration.updateMany({ where, data });
      if (res.count === 0) return editError(404, "not_found");
    } else {
      // The newest saved version IS the published overview — never hide it.
      const live = await db.write.overviewVersion.findFirst({
        where: { cwid: targetCwid, hiddenAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (live?.id === body.id) return editError(409, "live_version");
      const res = await db.write.overviewVersion.updateMany({ where, data });
      if (res.count === 0) return editError(404, "not_found");
    }
    return editOk({ id: body.id });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }
}
