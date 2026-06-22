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
import { type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { assembleOverviewFacts, hasSufficientFacts } from "@/lib/edit/overview-facts";
import {
  generateOverviewDraft,
  isOverviewGenerateEnabled,
  isOverviewGenerateStreamEnabled,
  resolveEffectiveOverviewModel,
  type OverviewProgress,
} from "@/lib/edit/overview-generator";
import { normalizeOverviewParams, normalizeOverviewSelection } from "@/lib/edit/overview-params";
import {
  defaultPromptVersionId,
  type OverviewPromptVersionId,
} from "@/lib/edit/overview-prompt-versions";
import { loadOverviewSelectionDeltas } from "@/lib/edit/overview-selection-store";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { recordOverviewGenerateAttempt } from "@/lib/edit/rate-limit";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import {
  editError,
  editOk,
  editOkStream,
  editRateLimited,
  logEditFailure,
  readEditRequest,
} from "@/lib/edit/request";

const PATH = "/api/edit/overview/generate";

// The generation can be STREAMED (see `editOkStream`), so the handler resolves a
// `Response` (the streamed body) for the streamed generate path and `NextResponse`
// (a buffered body) for the buffered path + the fast pre-checks — both are `Response`.
export async function POST(request: NextRequest): Promise<Response> {
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

  // --- prompt versioning (#742, `overview-prompt-versioning-spec.md` §6). Only a
  //     superuser / comms_steward (central) or an org-unit curator (unit-admin) may
  //     pick a NON-default prompt version; a faculty owner (self) or a proxy always
  //     generates on the live default. The owner's UI never sends a non-default, but
  //     the body is untrusted, so downgrade defensively here. ---
  const canSelectPromptVersion =
    session.isSuperuser || session.isCommsSteward || authz.viaUnitAdminUnit !== null;
  const effectiveParams =
    canSelectPromptVersion || params.promptVersion === defaultPromptVersionId()
      ? params
      : { ...params, promptVersion: defaultPromptVersionId() };

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
    // The scholar's DURABLE three-state deltas (§2.5) are loaded on EVERY path. For
    // publications / funding / methods an explicit posted snapshot still wins outright
    // (assembleOverviewFacts ignores those deltas when the snapshot is non-empty); but
    // titles & education (#742 §7) are NOT carried in the snapshot, so their deltas can
    // only reach the facts through the durable store — hence the unconditional load.
    const deltas = await loadOverviewSelectionDeltas(entityId);
    facts = await assembleOverviewFacts(entityId, selection, { deltas });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // A missing scholar row is a 404.
  if (!facts) return editError(404, "scholar_not_found", "entityId");

  // --- sparse-data gate (SPEC G2): too little signal to draft without padding. ---
  if (!hasSufficientFacts(facts)) return editError(422, "insufficient_facts");

  // --- persist (#742 Phase B + persist-every-run + audit parity). Record EVERY
  //     attempt — success AND failure — so the audit/debug trail is complete; the
  //     history panel filters to succeeded rows (`listOverviewGenerations`). Best-
  //     effort: the draft is the product, the row is bookkeeping — a write hiccup
  //     must never lose the draft, so this is its own try/catch and the route still
  //     returns the draft with generationId=null. ---
  const persistRun = async (
    outcome:
      | { ok: true; draft: string; model: string; promptVersion: OverviewPromptVersionId }
      | { ok: false; error: string },
  ): Promise<string | null> => {
    try {
      const row = await db.write.overviewGeneration.create({
        data: {
          cwid: entityId,
          // A failed run has no draft; `status` / `error` carry the outcome.
          text: outcome.ok ? outcome.draft : null,
          status: outcome.ok ? "succeeded" : "failed",
          error: outcome.ok ? null : outcome.error,
          // On failure no run model resolved — record the version's effective model.
          model: outcome.ok
            ? outcome.model
            : resolveEffectiveOverviewModel(effectiveParams.promptVersion),
          // The version that actually generated — a dedicated column for A/B analysis
          // (`GROUP BY prompt_version`); also mirrored inside `params` for restore.
          promptVersion: outcome.ok ? outcome.promptVersion : effectiveParams.promptVersion,
          // Persist the steering controls (incl. promptVersion + audience) + the source
          // selection (v3.1) in the one Json column so "Regenerate from these settings"
          // restores both.
          params: { ...effectiveParams, selection },
          // Attribute the ACCOUNTABLE HUMAN (`realCwid` = `manual_edit_audit.actor_cwid`),
          // with the "View as" overlay target in `impersonatedCwid` — audit parity with
          // `biosketch_generation` (NOT `session.cwid`, which is the effective/impersonated
          // identity).
          createdByCwid: realCwid,
          impersonatedCwid,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      logEditFailure(PATH, err);
      return null;
    }
  };

  // --- generate + persist, factored so the streamed and buffered paths run IDENTICAL
  //     logic. A gateway throw is recorded as a failed run and surfaced as a discriminated
  //     failure; this never throws. `onProgress` drives the streamed progress bar (no-op
  //     on the buffered path). ---
  const runGeneration = async (
    onProgress?: (event: OverviewProgress) => void,
  ): Promise<
    | {
        ok: true;
        draft: string;
        model: string;
        promptVersion: OverviewPromptVersionId;
        generationId: string | null;
      }
    | { ok: false; error: string }
  > => {
    let result: Awaited<ReturnType<typeof generateOverviewDraft>>;
    try {
      // Pass the progress sink ONLY on the streamed path — the buffered path keeps the
      // original 2-arg call (no behavior change, no spurious opts object).
      result = onProgress
        ? await generateOverviewDraft(facts, effectiveParams, { onProgress })
        : await generateOverviewDraft(facts, effectiveParams);
    } catch (err) {
      logEditFailure(PATH, err);
      await persistRun({ ok: false, error: "generation_failed" });
      return { ok: false, error: "generation_failed" };
    }
    const generationId = await persistRun({
      ok: true,
      draft: result.draft,
      model: result.model,
      promptVersion: result.promptVersion,
    });
    return {
      ok: true,
      draft: result.draft,
      model: result.model,
      promptVersion: result.promptVersion,
      generationId,
    };
  };

  // --- STREAMED path (sub-flag `SELF_EDIT_OVERVIEW_GENERATE_STREAM`). Emits NDJSON
  //     progress lines (the determinate <OverviewProgress> bar, #917 follow-up A) plus
  //     heartbeats that keep a slow Opus-4.8 draft from tripping the CloudFront origin-
  //     read timeout. A gateway failure becomes an in-body `{ ok: false }` result line
  //     (status already 200); the failed run is still persisted inside `runGeneration`. ---
  if (isOverviewGenerateStreamEnabled()) {
    return editOkStream(
      async (emit) => {
        const r = await runGeneration((event) => emit(event));
        if (!r.ok) throw new Error(r.error);
        return {
          draft: r.draft,
          model: r.model,
          promptVersion: r.promptVersion,
          generationId: r.generationId,
        };
      },
      () => ({ error: "generation_failed" }),
    );
  }

  // --- BUFFERED path (default / un-flipped env). Unchanged response shape: a gateway
  //     throw is a 502 (SPEC G8), every other outcome a single editOk JSON body. ---
  const r = await runGeneration();
  if (!r.ok) return editError(502, r.error);
  return editOk({
    draft: r.draft,
    model: r.model,
    promptVersion: r.promptVersion,
    generationId: r.generationId,
  });
}
