/**
 * POST /api/edit/overview/debug-payload (overview parity with #917 biosketch follow-up B).
 *
 * SUPERUSER-ONLY introspection: assembles the EXACT inputs the overview generator would send to
 * Bedrock — the resolved system prompt, the rendered user-turn prompt (incl. the steering
 * directives: voice / tone / AUDIENCE / length / emphasis), and the model-facts FACTS projection —
 * WITHOUT calling the gateway. A cheap, inspectable way to answer "what prompt is this scholar's
 * draft built from" before (or independent of) spending a real generation, and to verify how the
 * audience tier reshapes the prompt.
 *
 * Gating: flag `SELF_EDIT_OVERVIEW_GENERATE` (off ⇒ 404, same as generate), the SHARED
 * `authorizeOverviewWrite` predicate for the target, AND a hard `session.isSuperuser` requirement.
 * The raw FACTS projection is internal data (titles, abstracts, synopses, rationales, grant
 * titles), so — unlike generate, which any authorized editor may run — this introspection is
 * superuser-only (NOT comms-steward / proxy / unit-admin).
 *
 * Read-only: assembles + returns, no DB write, no Bedrock call, no history row, no rate-limit
 * (there is no cost to bound). No sparse-facts gate either — a superuser debugging a thin draft
 * wants to SEE the payload that produced it, not a 422.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { assembleOverviewFacts } from "@/lib/edit/overview-facts";
import {
  buildOverviewUserPrompt,
  isOverviewGenerateEnabled,
  overviewSystemPromptFor,
  resolveEffectiveOverviewModel,
  toModelFacts,
} from "@/lib/edit/overview-generator";
import { normalizeOverviewParams, normalizeOverviewSelection } from "@/lib/edit/overview-params";
import { loadOverviewSelectionDeltas } from "@/lib/edit/overview-selection-store";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/overview/debug-payload";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Flag first — a dormant feature 404s before any session or DB work.
  if (!isOverviewGenerateEnabled()) return editError(404, "not_found");

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid } = req.ctx;

  const { entityId } = req.ctx.body;
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }
  // Steering params are never trusted — normalize defensively, exactly as generate does, so the
  // assembled payload reflects what a real generate would build. `normalizeOverviewParams` already
  // coerces `promptVersion` to a valid id (invalid → live default), so `params.promptVersion` is the
  // resolved version; `audience` is likewise normalized to a known tier.
  const params = normalizeOverviewParams(req.ctx.body.params);

  // Authorize the target with the SHARED bio-write predicate (no drift with the generate route),
  // THEN hard-require superuser. A superuser already passes `authorizeOverviewWrite` for any
  // target, so this second gate is what NARROWS the debug surface below generate's authorized-editor
  // set — the assembled FACTS are internal data.
  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: entityId, path: PATH, reason: authz.reason });
    return editError(403, authz.reason);
  }
  if (!session.isSuperuser) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: entityId, path: PATH, reason: "forbidden" });
    return editError(403, "forbidden");
  }

  // Facts assembly — the scholar's standing curation (empty posted selection ⇒ the assembler
  // default) plus the durable three-state deltas, identical to the generate route's read.
  let facts: Awaited<ReturnType<typeof assembleOverviewFacts>>;
  try {
    const deltas = await loadOverviewSelectionDeltas(entityId);
    facts = await assembleOverviewFacts(entityId, normalizeOverviewSelection({}), { deltas });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
  if (!facts) return editError(404, "scholar_not_found", "entityId");

  const res = editOk({
    target: entityId,
    model: resolveEffectiveOverviewModel(params.promptVersion),
    promptVersion: params.promptVersion,
    audience: params.audience,
    systemPrompt: overviewSystemPromptFor(params.promptVersion),
    userPrompt: buildOverviewUserPrompt(facts, params),
    // The parsed FACTS object (the same projection embedded as a string inside `userPrompt`),
    // returned separately so the payload is machine-readable, not just a prompt blob.
    facts: toModelFacts(facts),
  });
  // Internal data — never cache.
  res.headers.set("cache-control", "no-store");
  return res;
}
