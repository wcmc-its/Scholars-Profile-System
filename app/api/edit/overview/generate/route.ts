/**
 * POST /api/edit/overview/generate (#742,
 * `docs/overview-statement-generator-spec.md` § The generate flow).
 *
 * Assembles the scholar's facts payload, calls the AI Gateway, and returns a
 * grounded, sanitized HTML draft. It NEVER writes the DB — the draft lands in
 * the `/edit` Tiptap editor as unsaved local state, and the existing
 * `POST /api/edit/field` is the only write path (SPEC § The generate flow).
 *
 * Authorization is the SHARED `authorizeOverviewWrite` — the generator allows
 * exactly whoever may WRITE the bio (#844 follow-up, "no special rules"): self OR
 * superuser OR granted proxy (#779) OR org-unit owner/curator (#728). Generating
 * a draft for a profile you cannot save would be pointless, so the two surfaces
 * share one predicate and cannot drift.
 *
 * Flag-gated behind `SELF_EDIT_OVERVIEW_GENERATE` (off ⇒ 404), mirroring the
 * slug-request route's dormancy.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { assembleOverviewFacts, hasSufficientFacts } from "@/lib/edit/overview-facts";
import { generateOverviewDraft, isOverviewGenerateEnabled } from "@/lib/edit/overview-generator";
import {
  isOverviewSelectionEmpty,
  normalizeOverviewParams,
  normalizeOverviewSelection,
} from "@/lib/edit/overview-params";
import { loadOverviewSelectionDeltas } from "@/lib/edit/overview-selection-store";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { recordOverviewGenerateAttempt } from "@/lib/edit/rate-limit";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
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
  const { session, realCwid, impersonatedCwid, requestId } = req.ctx;

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
  // The source selection (which pubs / funding / tools ground the draft, v3.1) is
  // likewise untrusted: clamped to 25 items + 10 tools here, then ownership-filtered
  // inside the facts queries. An empty selection ⇒ the facts assembler's default.
  const selection = normalizeOverviewSelection(req.ctx.body.selection);

  // --- authorization: the SHARED overview-write predicate (self OR superuser OR
  //     granted proxy OR org-unit owner/curator — #844 follow-up). Keyed on
  //     `realCwid`, gated to non-impersonating for the delegated legs (IS-1). The
  //     resolved unit is not needed here (the generator writes no audit row), only
  //     the allow/deny verdict. ---
  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: entityId,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  // --- per-scholar rate limit (DB write) + facts assembly (DB read). Both touch
  //     the database, so a DB error is a clean 500 here rather than an unhandled
  //     throw — matching /api/edit/field. The rate limit runs first (before the
  //     gateway call) so a burst can't run up cost; the bucket is keyed on the
  //     TARGET scholar (`entityId`), so a per-scholar cost cap holds regardless of
  //     which authorized actor (self / superuser / proxy / unit-admin) generates. ---
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
    // An explicit snapshot wins outright; otherwise fall to the scholar's DURABLE
    // three-state deltas (§2.5) layered on the default auto-set.
    const deltas = isOverviewSelectionEmpty(selection)
      ? await loadOverviewSelectionDeltas(entityId)
      : undefined;
    facts = await assembleOverviewFacts(entityId, selection, { deltas });
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

  // --- version history (#742 Phase B). Record EVERY successful draft so the
  //     scholar can browse / reload / regenerate from it. Best-effort: the draft
  //     is the product, the history row is bookkeeping — a write hiccup must
  //     never lose the draft, so this is wrapped in its own try/catch and the
  //     route still returns 200 with generationId=null. ---
  let generationId: string | null = null;
  try {
    const row = await db.write.overviewGeneration.create({
      data: {
        cwid: entityId,
        text: result.draft,
        model: result.model,
        // Persist the steering controls + the source selection (v3.1) in the one
        // Json column so "Regenerate from these settings" can restore both.
        params: { ...params, selection },
        createdByCwid: session.cwid,
      },
      select: { id: true },
    });
    generationId = row.id;
  } catch (err) {
    logEditFailure(PATH, err);
  }

  return editOk({ draft: result.draft, model: result.model, generationId });
}
