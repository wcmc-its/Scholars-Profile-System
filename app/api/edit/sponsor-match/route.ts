/**
 * `/api/edit/sponsor-match` — rank WCM researchers against a pasted sponsor
 * description (`docs/2026-07-09-ctl-technologies-handoff.md` §2).
 *
 * POST `{ description }` → `{ ok: true, researchers }` — one engine call
 * (`rankResearchersForDescription`: BM25 relevance × Variant-B, topical fit
 * only). No writes, no queue: the pasted text is a query, never persisted.
 *
 * Authorization mirrors the surface this lives on (`/edit/sponsor-match`) and
 * its sibling `/api/edit/opportunity-intake`: superuser OR development role,
 * with a denial log. 404 while `SPONSOR_MATCH` is off — the dark-ship posture.
 */
import { NextResponse, type NextRequest } from "next/server";

import { isSponsorMatchEnabled, rankResearchersForDescription } from "@/lib/api/sponsor-match";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/sponsor-match";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSponsorMatchEnabled()) return new NextResponse(null, { status: 404 });
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, body } = req.ctx;

  if (!(session.isSuperuser || session.isDeveloper)) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: "sponsor-match",
      path: PATH,
      reason: "not_developer_post",
    });
    return editError(403, "not_developer_post");
  }

  const { description } = body;
  if (typeof description !== "string" || description.trim().length === 0) {
    return editError(400, "invalid_description", "description");
  }

  try {
    return editOk({ researchers: await rankResearchersForDescription(description) });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(502, "match_unavailable");
  }
}
