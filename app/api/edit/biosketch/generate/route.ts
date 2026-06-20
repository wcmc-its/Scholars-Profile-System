/**
 * POST /api/edit/biosketch/generate (#917 v5,
 * `docs/overview-generator-v5-handoff.md` + `docs/overview-generator-prompt-v5.md`).
 *
 * Assembles the scholar's facts payload, calls the AI Gateway, and returns the NIH-biosketch
 * narrative prose — up to five character-capped Contributions to Science, OR one Personal
 * Statement. The output is a COPY/EXPORT grant-application artifact, NOT a saved profile
 * field: there is no save-to-profile flow (cf. the overview route, which also writes nothing
 * to the live bio). Every successful generation IS recorded best-effort to
 * `biosketch_generation` for audit/reuse, exactly like the overview route's history row.
 *
 * Authorization is the SHARED `authorizeOverviewWrite` — generating a biosketch for a profile
 * you cannot write would be pointless, so this reuses the bio-write predicate (self OR
 * superuser OR granted proxy OR org-unit owner/curator) rather than authoring a new one that
 * could drift. The biosketch is for the scholar's own applications, so that scope is exactly
 * right.
 *
 * Flag-gated behind `EDIT_BIOSKETCH_GENERATE` (off ⇒ 404), default-off and staging-first.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { assembleOverviewFacts, hasSufficientFacts } from "@/lib/edit/overview-facts";
import { generateBiosketch, isBiosketchGenerateEnabled } from "@/lib/edit/biosketch-generator";
import {
  missingPersonalStatementInputs,
  normalizeBiosketchParams,
} from "@/lib/edit/biosketch-params";
import { normalizeOverviewSelection } from "@/lib/edit/overview-params";
import { loadOverviewSelectionDeltas } from "@/lib/edit/overview-selection-store";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { recordBiosketchGenerateAttempt } from "@/lib/edit/rate-limit";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import {
  editError,
  editOk,
  editRateLimited,
  logEditFailure,
  readEditRequest,
} from "@/lib/edit/request";

const PATH = "/api/edit/biosketch/generate";

/** The biosketch prompt revision recorded with each generation (its own purpose, NOT an
 *  overview prompt-version id). Bumped when the BIOSKETCH_SYSTEM_PROMPT changes materially. */
const BIOSKETCH_PROMPT_VERSION = "v5";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Flag first — a dormant feature 404s before doing any work.
  if (!isBiosketchGenerateEnabled()) return editError(404, "not_found");

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId } = req.ctx;

  // --- body shape ---
  const { entityId } = req.ctx.body;
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }
  // Steering params are NEVER trusted — normalize defensively (unknown mode → contributions,
  // count clamped to 1..5, free text trimmed/clamped). A garbage value yields a usable shape.
  const params = normalizeBiosketchParams(req.ctx.body.params);

  // The Personal Statement sub-mode REQUIRES a project title + aims — without them the model
  // cannot honestly write the "directly relevant experience" framing (spec §USER-TURN). This
  // is the one explicit 400-on-bad-params: the inputs are not in the FACTS, so we cannot
  // default them. Contributions mode needs neither and never trips this.
  const missing = missingPersonalStatementInputs(params);
  if (missing.length > 0) {
    return editError(400, "missing_project_inputs", missing.join(","));
  }

  // --- authorization: the SHARED bio-write predicate (self OR superuser OR granted proxy OR
  //     org-unit owner/curator). Keyed on `realCwid`, gated to non-impersonating for the
  //     delegated legs. Only the allow/deny verdict is needed (no audit row is written). ---
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

  // --- per-scholar rate limit (DB write) + facts assembly (DB read). The rate limit runs
  //     first (before the gateway call) so a burst can't run up cost; its bucket is keyed on
  //     the TARGET scholar (`entityId`) under a DISTINCT `biosketch:` namespace, so the cap
  //     holds regardless of which authorized actor generates and never collides with the
  //     overview-generate cap. Facts use the scholar's standing curation (empty posted
  //     selection ⇒ the assembler default) plus the durable three-state deltas. ---
  let facts: Awaited<ReturnType<typeof assembleOverviewFacts>>;
  try {
    const rate = await recordBiosketchGenerateAttempt(entityId);
    if (!rate.allowed) {
      console.warn(
        JSON.stringify({
          event: "biosketch_generate_rate_limited",
          path: PATH,
          request_id: requestId,
          actor_cwid: session.cwid,
          count: rate.count,
          limit: rate.limit,
        }),
      );
      return editRateLimited(rate.retryAfterSeconds);
    }
    const deltas = await loadOverviewSelectionDeltas(entityId);
    facts = await assembleOverviewFacts(entityId, normalizeOverviewSelection({}), { deltas });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // A missing scholar row is a 404.
  if (!facts) return editError(404, "scholar_not_found", "entityId");

  // --- sparse-data gate: too little signal to draft without padding. ---
  if (!hasSufficientFacts(facts)) return editError(422, "insufficient_facts");

  // --- generate. A gateway throw / timeout is a 502 and NEVER writes the DB. ---
  let result: Awaited<ReturnType<typeof generateBiosketch>>;
  try {
    result = await generateBiosketch(facts, params);
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(502, "generation_failed");
  }

  // --- history (audit/reuse). Record EVERY successful generation. Best-effort: the entries
  //     are the product, the row is bookkeeping — a write hiccup must never lose the output,
  //     so this is wrapped in its own try/catch and the route still returns 200 with
  //     generationId=null. ---
  let generationId: string | null = null;
  try {
    const row = await db.write.biosketchGeneration.create({
      data: {
        cwid: entityId,
        mode: result.mode,
        entries: result.entries,
        // Project title/aims are personal-statement-only; NULL for contributions.
        projectTitle: params.mode === "personal_statement" ? params.projectTitle : null,
        projectAims: params.mode === "personal_statement" ? params.aims : null,
        model: result.model,
        promptVersion: BIOSKETCH_PROMPT_VERSION,
        // Persist the steering controls so "Regenerate from these settings" can restore them.
        params: {
          mode: params.mode,
          maxContributions: params.maxContributions,
          emphasis: params.emphasis,
          instructions: params.instructions,
        },
        createdByCwid: session.cwid,
      },
      select: { id: true },
    });
    generationId = row.id;
  } catch (err) {
    logEditFailure(PATH, err);
  }

  return editOk({
    mode: result.mode,
    entries: result.entries,
    model: result.model,
    // Surface the cap overflows + how many spans the faithfulness pass trimmed, so the
    // privileged control can show "N over the 2,000-char cap" / "trimmed N unverifiable
    // details" without re-deriving them client-side.
    overflow: result.overflow,
    removedCount: result.removed.length,
    generationId,
  });
}
