/**
 * POST /api/edit/overview/generate (#742,
 * `docs/overview-statement-generator-spec.md` § The generate flow).
 *
 * Assembles the scholar's facts payload, calls the AI Gateway, and returns a
 * grounded, sanitized HTML draft. It NEVER writes the DB — the draft lands in
 * the `/edit` Tiptap editor as unsaved local state, and the existing owner-gated
 * `POST /api/edit/field` is the only write path (SPEC § The generate flow). The
 * single-scholar flow is owner-only: the actor may generate only for THEIR OWN
 * profile (`authorizeFieldEdit(..., fieldName:"overview")`), mirroring the
 * self-only overview edit; the bulk/admin staging path is a separate SPEC slice.
 *
 * Flag-gated behind `SELF_EDIT_OVERVIEW_GENERATE` (off ⇒ 404), mirroring the
 * slug-request route's dormancy.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { authorizeFieldEdit, logEditDenial } from "@/lib/edit/authz";
import { assembleOverviewFacts, hasSufficientFacts } from "@/lib/edit/overview-facts";
import {
  generateOverviewDraft,
  isOverviewGenerateEnabled,
} from "@/lib/edit/overview-generator";
import { normalizeOverviewParams } from "@/lib/edit/overview-params";
import { recordOverviewGenerateAttempt } from "@/lib/edit/rate-limit";
import {
  editError,
  editOk,
  editRateLimited,
  logEditFailure,
  readEditRequest,
} from "@/lib/edit/request";

const PATH = "/api/edit/overview/generate";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Flag first — a dormant feature 404s before doing any work (mirrors the
  // slug-request route).
  if (!isOverviewGenerateEnabled()) return editError(404, "not_found");

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, requestId } = req.ctx;

  // --- body shape ---
  const { entityId } = req.ctx.body;
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }
  // Steering params are NEVER trusted — normalize defensively (unknown enums →
  // defaults, elements filtered, instructions trimmed/clamped). A garbage value
  // yields a usable shape, so there is no 400-on-bad-params; only entityId is
  // validated (#742 Phase A).
  const params = normalizeOverviewParams(req.ctx.body.params);

  // --- authorization: owner-only (overview is self-only — a superuser does not
  //     inherit it, matching authorizeFieldEdit). ---
  const authz = authorizeFieldEdit(session, { entityId, fieldName: "overview" });
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: entityId,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  // --- per-cwid rate limit (DB write) + facts assembly (DB read). Both touch
  //     the database, so a DB error is a clean 500 here rather than an unhandled
  //     throw — matching /api/edit/field. The rate limit runs first (before the
  //     gateway call) so a burst can't run up cost; the actor is always the
  //     target (owner-only), so the bucket key is the actor's cwid. ---
  let facts: Awaited<ReturnType<typeof assembleOverviewFacts>>;
  try {
    const rate = await recordOverviewGenerateAttempt(entityId);
    if (!rate.allowed) {
      console.warn(
        JSON.stringify({
          event: "overview_generate_rate_limited",
          path: PATH,
          request_id: requestId,
          actor_cwid: session.cwid,
          count: rate.count,
          limit: rate.limit,
        }),
      );
      return editRateLimited(rate.retryAfterSeconds);
    }
    facts = await assembleOverviewFacts(entityId);
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // A missing scholar row is a 404.
  if (!facts) return editError(404, "scholar_not_found", "entityId");

  // --- sparse-data gate (SPEC G2): too little signal to draft without padding. ---
  if (!hasSufficientFacts(facts)) return editError(422, "insufficient_facts");

  // --- generate. A gateway throw / timeout is a 502 and NEVER writes the DB
  //     (SPEC G8). ---
  let result: Awaited<ReturnType<typeof generateOverviewDraft>>;
  try {
    result = await generateOverviewDraft(facts, params);
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(502, "generation_failed");
  }

  return editOk({ draft: result.draft, model: result.model });
}
