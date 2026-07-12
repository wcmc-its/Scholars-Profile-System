/**
 * `/api/edit/sponsor-match` — rank WCM researchers against a pasted sponsor
 * description (`docs/2026-07-09-ctl-technologies-handoff.md` §2).
 *
 * POST `{ description }` → `{ ok: true, researchers, concepts }` — one engine call.
 * `concepts` is the `{term, centrality}` set the spine used (always `[]` for the
 * bespoke engine, which does no concept decomposition), so the editable-centrality
 * console can render and reweight it. The default engine is the bespoke
 * `rankResearchersForDescription` (BM25 relevance × Variant-B, topical fit only). No
 * writes, no queue: the pasted text is a query, never persisted.
 *
 * Engine selection (`SPONSOR_MATCH_SPINE`, a dark sub-flag of `SPONSOR_MATCH`):
 * while OFF the route is byte-identical to before — always bespoke, any `engine` /
 * `concepts` field ignored (bar the always-`[]` concepts in the response). While ON
 * the searchPeople per-term spine (`rankResearchersForDescriptionSpine`) becomes the
 * default, and an optional body `engine: "spine" | "bespoke"` forces either so both
 * can be captured on the SAME deploy for the offline bake-off. An unrecognized
 * `engine` value (flag on) → 400.
 *
 * Concept override (flag on, spine engine): an optional body `concepts:
 * {term, centrality}[]` REPLACES Bedrock extraction — the console's re-rank posts the
 * SAME description with edited centralities to re-score the same candidate universe
 * with no new extraction. It is a trust boundary: the shape is validated and the
 * values sanitized (`sanitizeConcepts`) before use; a malformed shape → 400.
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
import { sanitizeConcepts, type SponsorConcept } from "@/lib/api/sponsor-match-extract";
import { rankResearchersForDescriptionSpine } from "@/lib/api/sponsor-match-spine-run";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/sponsor-match";

export const dynamic = "force-dynamic";

/** Trust-boundary parse of the optional `concepts` override (the console re-rank).
 *  Returns the SANITIZED concept set on a well-formed array, or `null` to signal a
 *  malformed shape (→ 400). Shape rules: an array whose every element is an object with
 *  a non-empty string `term` and a finite-number `centrality`. Value hygiene (clamp to
 *  (0,1], floor non-positive to 0.3, dedupe, cap) is delegated to `sanitizeConcepts` so
 *  the override is cleaned by the EXACT rules the LLM output is. */
function parseConceptsOverride(raw: unknown): SponsorConcept[] | null {
  if (!Array.isArray(raw)) return null;
  for (const c of raw) {
    if (c == null || typeof c !== "object") return null;
    const { term, centrality } = c as { term?: unknown; centrality?: unknown };
    if (typeof term !== "string" || term.trim() === "") return null;
    if (typeof centrality !== "number" || !Number.isFinite(centrality)) return null;
  }
  return sanitizeConcepts(raw as { term: string; centrality: number }[]);
}

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

  // Engine selection. Flag OFF ⇒ bespoke, `engine`/`concepts` ignored (byte-identical
  // to before). Flag ON ⇒ spine by default; `engine` may force either for the same-
  // deploy bake-off, and the spine engine accepts an optional `concepts` override.
  let useSpine = false;
  let conceptsOverride: SponsorConcept[] | undefined;
  if (isSponsorMatchSpineEnabled()) {
    const { engine } = body;
    if (engine !== undefined && engine !== "spine" && engine !== "bespoke") {
      return editError(400, "invalid_engine", "engine");
    }
    useSpine = engine !== "bespoke";

    // Concept override (the editable-centrality console re-rank) — only meaningful for
    // the spine engine. Present-but-malformed ⇒ 400; absent ⇒ normal extraction.
    if (useSpine && body.concepts !== undefined) {
      const parsed = parseConceptsOverride(body.concepts);
      if (parsed === null) return editError(400, "invalid_concepts", "concepts");
      conceptsOverride = parsed;
    }
  }

  try {
    if (useSpine) {
      const { researchers, concepts } = await rankResearchersForDescriptionSpine(description, {
        conceptsOverride,
      });
      return editOk({ researchers, concepts });
    }
    // Bespoke has no concept decomposition — always an empty `concepts` for a uniform
    // client contract (the console's concept editor stays hidden on the bespoke shape).
    const researchers = await rankResearchersForDescription(description);
    return editOk({ researchers, concepts: [] });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(502, "match_unavailable");
  }
}
