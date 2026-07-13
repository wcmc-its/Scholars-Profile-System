/**
 * `/api/edit/sponsor-match` — rank WCM researchers against a pasted sponsor
 * description (`docs/2026-07-09-ctl-technologies-handoff.md` §2).
 *
 * POST `{ description }` → `SponsorMatchResponse` (`lib/api/sponsor-match-contract.ts`):
 * `{ ok, concepts, candidates }`. One engine call. No writes, no queue: the pasted text
 * is a query, never persisted.
 *
 * THE RESPONSE IS DECOMPOSED, NOT SCALAR. `concepts[]` carries each merged concept's
 * editable `centrality` and fixed `weightFactor`; `candidates[].contributions[]` carries every
 * (concept, rank) pair the fusion summed. The console re-ranks LIVE in the browser from
 * those inputs (`rerankCandidates`), so moving a slider costs zero round-trips. See the
 * contract module for the invariant and why it matters.
 *
 * NOTE there is deliberately no `concepts` request field. PR #1673 accepted a
 * client-supplied concept override and re-retrieved + re-fused on every slider drag —
 * seconds per drag, and exactly the "re-query on every drag" degradation the contract
 * rejects. Removing it also removes a client-controlled trust boundary; nothing on the
 * request side needs sanitizing now beyond `description` and `engine`.
 *
 * Engine selection (`SPONSOR_MATCH_SPINE`, a dark sub-flag of `SPONSOR_MATCH`):
 * flag OFF ⇒ always the bespoke `rankResearchersForDescription` (one BM25 round-trip over
 * the whole paste), and any `engine` field is ignored. Flag ON ⇒ the searchPeople per-term
 * spine is the default, and an optional body `engine: "spine" | "bespoke"` forces either so
 * both can be captured on the SAME deploy for the offline bake-off. An unrecognized
 * `engine` (flag on) → 400.
 *
 * BOTH engines answer in the contract shape, so the console has one response type. The
 * bespoke engine does no concept decomposition, so it returns `concepts: []` and
 * `contributions: []` — the rail hides itself and the client re-rank is a no-op, which is
 * the honest rendering of an engine that has no per-concept signal to edit. It does supply
 * `measures` + `evidence`, which the spine cannot.
 *
 * Authorization mirrors the surface this lives on (`/edit/sponsor-match`) and
 * its sibling `/api/edit/opportunity-intake`: superuser OR development role,
 * with a denial log. 404 while `SPONSOR_MATCH` is off — the dark-ship posture.
 */
import { NextResponse, type NextRequest } from "next/server";

import type { SponsorCandidate } from "@/lib/api/sponsor-match-contract";
import {
  isSponsorMatchEnabled,
  isSponsorMatchSpineEnabled,
  rankResearchersForDescription,
  type SponsorRankedScholar,
} from "@/lib/api/sponsor-match";
import { rankResearchersForDescriptionSpine } from "@/lib/api/sponsor-match-spine-run";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/sponsor-match";

export const dynamic = "force-dynamic";

/** Bespoke engine → the wire contract. It has no concept decomposition, so
 *  `contributions` is empty (nothing to re-rank over client-side — see the module doc).
 *  It DOES carry the signals the spine's headless shape cannot: a career stage, the
 *  matched topics with real pub counts, and the scored top papers. */
function bespokeToCandidate(r: SponsorRankedScholar): SponsorCandidate {
  return {
    cwid: r.cwid,
    name: r.preferredName ?? r.slug,
    profileSlug: r.slug,
    title: r.title ?? null,
    department: r.department ?? null,
    fusedScore: r.defaultScore,
    contributions: [],
    technologyCount: r.technologyCount ?? 0,
    measures: { careerStage: r.careerStage },
    evidence: {
      topics: r.matchedTopics.map((t) => ({ label: t.label, pubCount: t.pubCount })),
      papers: r.topPapers.map((p) => ({
        pmid: p.pmid,
        title: p.title,
        year: p.year,
        journal: p.journal,
        relevance: p.relevance,
      })),
    },
  };
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

  // Engine selection. Flag OFF ⇒ bespoke, `engine` ignored. Flag ON ⇒ spine by default;
  // `engine` may force either for the same-deploy bake-off.
  let useSpine = false;
  if (isSponsorMatchSpineEnabled()) {
    const { engine } = body;
    if (engine !== undefined && engine !== "spine" && engine !== "bespoke") {
      return editError(400, "invalid_engine", "engine");
    }
    useSpine = engine !== "bespoke";
  }

  try {
    if (useSpine) {
      const { concepts, candidates } = await rankResearchersForDescriptionSpine(description);
      return editOk({ concepts, candidates });
    }
    const researchers = await rankResearchersForDescription(description);
    return editOk({ concepts: [], candidates: researchers.map(bespokeToCandidate) });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(502, "match_unavailable");
  }
}
