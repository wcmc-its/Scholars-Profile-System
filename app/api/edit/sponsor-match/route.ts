/**
 * `/api/edit/sponsor-match` — rank WCM researchers against a pasted sponsor
 * description (`docs/2026-07-09-ctl-technologies-handoff.md` §2).
 *
 * POST `{ description }` → `{ ok: true, researchers }` — one engine call. The
 * default engine is the bespoke `rankResearchersForDescription` (BM25 relevance ×
 * Variant-B, topical fit only). No writes, no queue: the pasted text is a query,
 * never persisted.
 *
 * Engine selection (`SPONSOR_MATCH_SPINE`, a dark sub-flag of `SPONSOR_MATCH`):
 * while OFF the route is byte-identical to before — always bespoke, any `engine`
 * field ignored. While ON the searchPeople per-term spine
 * (`rankResearchersForDescriptionSpine`) becomes the default, and an optional body
 * `engine: "spine" | "bespoke"` forces either so both can be captured on the SAME
 * deploy for the offline bake-off. An unrecognized `engine` value (flag on) → 400.
 *
 * Authorization mirrors the surface this lives on (`/edit/sponsor-match`) and
 * its sibling `/api/edit/opportunity-intake`: superuser OR development role,
 * with a denial log. 404 while `SPONSOR_MATCH` is off — the dark-ship posture.
 */
import { NextResponse, type NextRequest } from "next/server";

import {
  isSponsorMatchEnabled,
  isSponsorMatchSpineEnabled,
  rankResearchersForDescription,
} from "@/lib/api/sponsor-match";
import { rankResearchersForDescriptionSpine } from "@/lib/api/sponsor-match-spine-run";
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

  // Engine selection. Flag OFF ⇒ bespoke, `engine` ignored (byte-identical to before).
  // Flag ON ⇒ spine by default; `engine` may force either for the same-deploy bake-off.
  let useSpine = false;
  if (isSponsorMatchSpineEnabled()) {
    const { engine } = body;
    if (engine !== undefined && engine !== "spine" && engine !== "bespoke") {
      return editError(400, "invalid_engine", "engine");
    }
    useSpine = engine !== "bespoke";
  }

  try {
    const researchers = useSpine
      ? await rankResearchersForDescriptionSpine(description)
      : await rankResearchersForDescription(description);
    return editOk({ researchers });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(502, "match_unavailable");
  }
}
