/**
 * `/api/edit/sponsor-match` — rank WCM researchers against a pasted sponsor
 * description (`docs/2026-07-09-ctl-technologies-handoff.md` §2).
 *
 * POST `{ description }` → `SponsorMatchResponse` (`lib/api/sponsor-match-contract.ts`):
 * `{ ok, concepts, candidates }`. One engine call. No writes, no queue: the pasted text
 * is a query, never persisted.
 *
 * THE PASTE IS NEVER A CACHE KEY EITHER (#6c). Re-submitting an identical paste — the
 * console's history replay does exactly this — used to re-run the whole spine: a Bedrock
 * extraction plus up to 8 paged `searchPeople` rounds. It is now memoised, but under two
 * rules that keep the promise above literally true:
 *
 *   1. The KEY is a SHA-256 of the paste, never the paste. A Map keyed on the raw text
 *      would hold the sponsor's words in memory long after the request that carried them.
 *   2. The VALUE is `{ concepts, candidates }` ONLY. `preferences` is deliberately NOT
 *      cached: `SponsorPreference.evidence` is a verbatim ±40-character slice of the paste
 *      (`sponsor-preferences.ts`), so caching it would store the sponsor's prose — the exact
 *      thing this route promises not to retain. It is recomputed per request instead, which
 *      is free: `extractSponsorPreferences` is a pure synchronous function, not the
 *      expensive call.
 *
 * The engine is part of the key — spine and bespoke answer the same paste differently.
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
import { createHash } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { cachedReasonAgg } from "@/lib/api/reason-agg-cache";
import type {
  SponsorCandidate,
  SponsorConcept,
} from "@/lib/api/sponsor-match-contract";
import { sponsorAskFrom } from "@/lib/api/sponsor-match-contract";
import {
  isSponsorMatchEnabled,
  isSponsorMatchSpineEnabled,
  normalizeDescription,
  rankResearchersForDescription,
  type SponsorRankedScholar,
} from "@/lib/api/sponsor-match";
import { rankResearchersForDescriptionSpine } from "@/lib/api/sponsor-match-spine-run";
import { extractSponsorPreferences } from "@/lib/api/sponsor-preferences";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/sponsor-match";

export const dynamic = "force-dynamic";

/**
 * Cache key for a submission: `sponsor:<engine>:<sha256 of the engine's input>`.
 *
 * Hashed, not stored — see the module doc.
 *
 * THE KEY HASHES `normalizeDescription(description)`, NOT THE RAW PASTE, and that is load-
 * bearing rather than tidy: `normalizeDescription` is what BOTH engines actually consume, and
 * it truncates at MAX_DESCRIPTION_CHARS while preserving newlines. Hash anything else and the
 * key stops being a function of the engine's input — two pastes that normalise to the same
 * 3,000 characters but differ in their (discarded) tail would collide, and two pastes that
 * differ only in line wrapping would produce DIFFERENT engine inputs (different content
 * survives the truncation) under the SAME key. Keying on the exact string the engine reads
 * makes "same key ⇒ same answer" true by construction instead of by argument.
 *
 * Case is preserved, because `normalizeDescription` preserves it and the extractor is an LLM:
 * "CF" and "cf" are not reliably the same token to it.
 *
 * ponytail: reuses `cachedReasonAgg` — a bounded Map + TTL + inflight-dedup + FIFO eviction
 * that is generic in its value type; only its NAME is reason-agg specific (a rename would
 * churn six call sites in the search hot path, so it is left for a janitorial PR). Its
 * 30-minute staleness ceiling is also the answer to "when does a cached match go stale?":
 * the People index is rebuilt nightly, and an entry that cannot outlive 30 minutes can never
 * outlive an ETL run. Ceiling — the cache is per-task and prod runs 2-6 tasks with no ALB
 * stickiness, so the hit rate is ~1/N, not 1. It is never a loss (a miss is exactly today's
 * behaviour); make it shared only if the Bedrock spend ever justifies the infrastructure.
 */
function sponsorCacheKey(engineInput: string, engine: "spine" | "bespoke"): string {
  const digest = createHash("sha256").update(engineInput, "utf8").digest("hex");
  return `sponsor:${engine}:${digest}`;
}

/** What is safe to memoise: the expensive, derived half of the answer. NOT `preferences` —
 *  those carry verbatim paste quotes. See the module doc. */
type SponsorEngineResult = { concepts: SponsorConcept[]; candidates: SponsorCandidate[] };

/**
 * NEVER CACHE AN EMPTY RESULT — the difference between a memo and a stuck failure.
 *
 * `extractSponsorConcepts` does not throw when Bedrock throttles, times out, or returns
 * malformed JSON: it logs and returns `[]` (a deliberate fail-soft). The spine then falls back
 * to the v1 dictionary extractor, which is documented to find nothing on real prose, and
 * RESOLVES with `{ concepts: [], candidates: [] }`. A resolved value is a cacheable value — so
 * a ten-second Bedrock blip would be frozen into the cache, and the officer's instinctive
 * re-submit would be served that same empty answer instantly, without ever retrying Bedrock,
 * until the entry aged out. The cache would have converted a transient, self-healing outage
 * into a sticky one, and invisibly: an instant empty result is indistinguishable from "this
 * paste genuinely matches nobody".
 *
 * A zero-candidate result is therefore treated as degraded and left uncached, so the next
 * submit re-runs the engine — exactly the behaviour that existed before this cache did. The
 * cost of being wrong (a genuinely unmatchable paste re-runs the engine) is one wasted call;
 * the cost of the alternative is a matcher that stays broken after the outage has passed.
 */
function isCacheableResult(r: SponsorEngineResult): boolean {
  return r.candidates.length > 0;
}

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
    measures: {
      careerStage: r.careerStage,
      isClinician: r.isClinician,
      roleCategory: r.roleCategory,
    },
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
    // #1654 — the sponsor's non-topical asks. Deterministic, engine-independent, and NOT
    // applied to the order shipped here: the response carries the preferences and the
    // `measures` they read, and the CONSOLE applies the boost live (contract invariant — the
    // UI owns the predicate, and the officer can deselect a preference the extractor got
    // wrong). Shipping a pre-nudged order would freeze that decision on the server.
    const preferences = extractSponsorPreferences(description);

    const engine = useSpine ? "spine" : "bespoke";
    const { concepts, candidates } = await cachedReasonAgg<SponsorEngineResult>(
      sponsorCacheKey(normalizeDescription(description), engine),
      async () => {
        if (useSpine) return rankResearchersForDescriptionSpine(description);
        const researchers = await rankResearchersForDescription(description);
        return { concepts: [], candidates: researchers.map(bespokeToCandidate) };
      },
      isCacheableResult,
    );

    // The search's handle, derived — not generated. See `sponsorAskFrom`.
    return editOk({ concepts, candidates, preferences, ask: sponsorAskFrom(concepts, preferences) });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(502, "match_unavailable");
  }
}
