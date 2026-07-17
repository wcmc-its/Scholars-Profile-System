/**
 * `/api/edit/matcha` — rank WCM researchers against a pasted sponsor
 * description (`docs/2026-07-09-ctl-technologies-handoff.md` §2).
 *
 * POST `{ description }` → `MatchaResponse` (`lib/api/sponsor-match-contract.ts`):
 * `{ ok, concepts, candidates }`. One engine call.
 *
 * GET — every retained search, newest first, so officers see each other's.
 * DELETE `{ submissionId }` — erase one. Any officer on this surface may erase any row.
 *
 * THE SEARCH IS NOW RETAINED (#6d), REVERSING THIS ROUTE'S ORIGINAL POSTURE. It was built to
 * persist nothing — "the pasted text is a query, never persisted" — because sponsor
 * descriptions were held to be commercially sensitive. That rule had no policy behind it: the
 * claim existed in one code comment and nowhere else, while this same app already stores
 * funder prose (`Opportunity.synopsis`) and already ships every paste to Bedrock and
 * OpenSearch. The line was assumed, not drawn.
 *
 * It is now drawn the other way, deliberately: `SponsorMatchSubmission` keeps the paste IN
 * FULL, because real sponsor text is the one thing the matcher cannot be tuned without (a gold
 * set we wrote ourselves can only contain what we thought to ask for — see the iteration
 * handoff §0). The officer is TOLD their searches are kept and why, and can DELETE any of them.
 *
 * THE PASTE IS STILL NOT A CACHE KEY, AND THE CACHE STILL HOLDS NO PASTE TEXT (#6c) — and now
 * for a sharper reason than privacy-in-general: DELETE MUST ACTUALLY DELETE. If the result
 * cache held the sponsor's words, erasing a submission would leave them resident in RAM on
 * every task that had served it, and the delete button would be a lie. So:
 *
 *   1. The KEY is a SHA-256 of the engine's input, never the text itself.
 *   2. The VALUE is `{ concepts, candidates }` ONLY. `preferences` is NOT cached:
 *      `MatchaPreference.evidence` is a verbatim ±40-character slice of the paste
 *      (`sponsor-preferences.ts`). It is recomputed per request, which is free —
 *      `extractMatchaPreferences` is a pure synchronous function, not the expensive call.
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
 * Engine selection (`MATCHA_SPINE`, a dark sub-flag of `MATCHA`):
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
 * Authorization mirrors the surface this lives on (`/edit/matcha`) and
 * its sibling `/api/edit/opportunity-intake`: superuser OR development role,
 * with a denial log. 404 while `MATCHA` is off — the dark-ship posture.
 */
import { createHash } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { cachedReasonAgg } from "@/lib/api/reason-agg-cache";
import type {
  MatchaCandidate,
  MatchaConcept,
} from "@/lib/api/matcha-contract";
import { askTitleFrom } from "@/lib/api/matcha-contract";
import {
  isMatchaEnabled,
  isMatchaSpineEnabled,
  normalizeDescription,
  rankResearchersForDescription,
  type MatchaRankedScholar,
} from "@/lib/api/matcha";
import { rankResearchersForDescriptionSpine } from "@/lib/api/matcha-spine-run";
import { extractMatchaPreferences } from "@/lib/api/matcha-preferences";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { identityImageEndpoint } from "@/lib/headshot";

const PATH = "/api/edit/matcha";

/** The list is a working memory, not an archive to page through. Newest first, one row per
 *  DISTINCT paste (see GET). */
const SUBMISSION_LIST_MAX = 100;

/** Rows scanned to fill those 100 distinct pastes. The table keeps every RUN, so the newest
 *  100 rows can be far fewer than 100 pastes — a paste re-run four times in a row (which is
 *  what staging actually looks like) burns four rows to yield one.
 *
 *  ponytail: a 5x window and a JS dedup, not a SQL GROUP BY. The ceiling is explicit — a single
 *  paste re-run >500 times consecutively could push an older paste off the list — and at that
 *  point the officer has bigger problems than a truncated history. Group in SQL if it bites. */
const SUBMISSION_SCAN_MAX = SUBMISSION_LIST_MAX * 5;

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
function sponsorInputHash(engineInput: string): string {
  return createHash("sha256").update(engineInput, "utf8").digest("hex");
}

/** The cache key. Shares its digest with `SponsorMatchSubmission.descriptionHash`, so a
 *  retained row and the cached result for that same search are joinable on one value. */
function sponsorCacheKey(inputHash: string, engine: "spine" | "bespoke"): string {
  return `sponsor:${engine}:${inputHash}`;
}

/** What is safe to memoise: the expensive, derived half of the answer. NOT `preferences` —
 *  those carry verbatim paste quotes. See the module doc. */
type MatchaEngineResult = {
  concepts: MatchaConcept[];
  candidates: MatchaCandidate[];
  /** The spine's LLM-written search title (absent for the bespoke engine, which has no
   *  extraction). Cached with the rest of the result; prefers over a concept-list title. */
  titleSummary?: string;
};

/**
 * NEVER CACHE AN EMPTY RESULT — the difference between a memo and a stuck failure.
 *
 * `extractMatchaConcepts` does not throw when Bedrock throttles, times out, or returns
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
function isCacheableResult(r: MatchaEngineResult): boolean {
  return r.candidates.length > 0;
}

/** Bespoke engine → the wire contract. It has no concept decomposition, so
 *  `contributions` is empty (nothing to re-rank over client-side — see the module doc).
 *  It DOES carry the signals the spine's headless shape cannot: a career stage, the
 *  matched topics with real pub counts, and the scored top papers. */
function bespokeToCandidate(r: MatchaRankedScholar): MatchaCandidate {
  return {
    cwid: r.cwid,
    name: r.preferredName ?? r.slug,
    profileSlug: r.slug,
    title: r.title ?? null,
    department: r.department ?? null,
    fusedScore: r.defaultScore,
    contributions: [],
    technologyCount: r.technologyCount ?? 0,
    identityImageEndpoint: identityImageEndpoint(r.cwid),
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
  if (!isMatchaEnabled()) return new NextResponse(null, { status: 404 });
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
  if (isMatchaSpineEnabled()) {
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
    const preferences = extractMatchaPreferences(description);

    const engine = useSpine ? "spine" : "bespoke";
    const engineInputHash = sponsorInputHash(normalizeDescription(description));
    const { concepts, candidates, titleSummary } = await cachedReasonAgg<MatchaEngineResult>(
      sponsorCacheKey(engineInputHash, engine),
      async () => {
        if (useSpine) return rankResearchersForDescriptionSpine(description);
        const researchers = await rankResearchersForDescription(description);
        return { concepts: [], candidates: researchers.map(bespokeToCandidate) };
      },
      isCacheableResult,
    );

    // The search's handle. The essence + org come from the extractor's `titleSummary` (written
    // in the SAME extraction call, not a second one); `askTitleFrom` prefers it and falls
    // back to a derived concept list, then appends the active preference chips.
    const ask = askTitleFrom(concepts, preferences, titleSummary);

    // #6d — retain the search. Recorded even on a CACHE HIT: the row is a record of what an
    // officer asked, not of what the engine computed, and two officers running the same paste
    // is exactly the fact the list exists to surface.
    //
    // FAIL-SOFT, and that is the whole design. A retention write must never cost the officer
    // their answer — the ranking is the product, the archive is a by-product. A DB blip logs
    // and is swallowed; the results still ship.
    try {
      await db.write.sponsorMatchSubmission.create({
        data: {
          description,
          descriptionHash: engineInputHash,
          title: ask?.title ?? null,
          engine,
          candidateCount: candidates.length,
          submittedBy: session.cwid,
        },
      });
    } catch (err) {
      logEditFailure(`${PATH}#retain`, err);
    }

    return editOk({ concepts, candidates, preferences, ask, titleSummary });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(502, "match_unavailable");
  }
}

/**
 * GET — the retained searches, newest first, ACROSS OFFICERS, ONE ROW PER PASTE.
 *
 * Cross-officer is the point. The console already kept a private history in each officer's
 * localStorage; a second private list would have been a reimplementation. What nobody could see
 * before is that a colleague has already run this sponsor — which is the duplicated work this
 * list exists to prevent.
 *
 * The paste itself rides along, because the officer must be able to read back what was searched
 * (and re-run it). It is the same text they pasted, returned to the same authorised surface.
 *
 * DEDUPED ON `descriptionHash`, and the two halves of that sentence live in different places.
 * The TABLE keeps every run on purpose — `descriptionHash` is deliberately non-unique, because
 * the same paste re-run after a nightly reindex is a genuinely different search and squashing
 * them would destroy the record of WHEN a result changed (staging has one paste at 438
 * candidates on 7/13 and 430 on 7/14; that delta is the point of retaining rows at all). That
 * record is for MEASUREMENT, and it survives untouched in the DB.
 *
 * The LIST is not measurement. It answers three questions — has a colleague run this sponsor,
 * can I re-run it, can I erase it — and all three are per-PASTE, not per-run. Four identical
 * rows answer them four times and read as a bug, which is exactly how this was reported.
 *
 * ponytail: dedup in JS over a bounded scan window, not `distinct` + `take` — Prisma applies
 * `distinct` in memory AFTER `take` on MySQL, so the two together silently return fewer rows
 * than asked for. The window is the known ceiling: a paste run more than SCAN/LIST times in a
 * row could push an older distinct paste off the end. Raise SCAN, or group in SQL, if that ever
 * bites.
 */
export async function GET(): Promise<NextResponse> {
  if (!isMatchaEnabled()) return new NextResponse(null, { status: 404 });
  const session = await getEffectiveEditSession();
  if (!session || !(session.isSuperuser || session.isDeveloper)) {
    return new NextResponse(null, { status: 403 });
  }
  try {
    const rows = await db.read.sponsorMatchSubmission.findMany({
      orderBy: { createdAt: "desc" },
      take: SUBMISSION_SCAN_MAX,
      select: {
        id: true,
        description: true,
        descriptionHash: true,
        title: true,
        engine: true,
        candidateCount: true,
        submittedBy: true,
        createdAt: true,
      },
    });

    // Rows arrive newest-first, so the FIRST row seen for a hash IS the newest run of that
    // paste — the one whose id the Delete button should carry and whose count is current.
    const newestPerPaste = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!newestPerPaste.has(row.descriptionHash)) newestPerPaste.set(row.descriptionHash, row);
    }
    // An explicit ALLOWLIST, not a `...rest` omit of `descriptionHash`: the hash is an internal
    // join key the console has no use for, and spreading the row would put every column added to
    // this model in future on the wire by default. Naming the fields makes leaking one a choice.
    const submissions = Array.from(newestPerPaste.values())
      .slice(0, SUBMISSION_LIST_MAX)
      .map((row) => ({
        id: row.id,
        description: row.description,
        title: row.title,
        engine: row.engine,
        candidateCount: row.candidateCount,
        submittedBy: row.submittedBy,
        createdAt: row.createdAt,
      }));

    return editOk({ submissions });
  } catch (err) {
    logEditFailure(`${PATH}#list`, err);
    return editError(502, "submissions_unavailable");
  }
}

/**
 * DELETE `{ submissionId }` — erase a retained search.
 *
 * ANY officer on this surface may delete ANY row, not merely their own. The button exists so a
 * sponsor's words can be taken back out of the system on request; scoping that to the person
 * who happened to paste them would mean a colleague's absence could block an erasure we have
 * committed to honouring. Everyone here already holds superuser or developer, and every
 * deletion is logged.
 *
 * ERASES EVERY RUN OF THAT PASTE, not the one row whose id was clicked — and that is a FIX, not
 * a widening of scope.
 *
 * The console promises, in as many words: "Delete any search to remove its text for good." It
 * was not true. `descriptionHash` is deliberately non-unique (every re-run is its own row), so
 * a paste an officer had run three times had THREE rows carrying the sponsor's prose verbatim,
 * and deleting by `id` erased one of them and left the text sitting in the other two. The
 * doc-comment here previously asserted "nothing of the sponsor's prose survives this call",
 * which was false in the normal case — the paste that has been run more than once.
 *
 * A retention promise that holds only for pastes run exactly once is not a retention promise.
 * The unit of erasure is therefore the PASTE (`descriptionHash`), which is the unit the promise
 * is made about. The id still identifies WHICH paste; it no longer bounds what is erased.
 *
 * The result cache holds no verbatim paste text by construction (see the module doc), so with
 * every row gone, nothing of the sponsor's prose survives this call. Now the sentence is true.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (!isMatchaEnabled()) return new NextResponse(null, { status: 404 });
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, body } = req.ctx;

  if (!(session.isSuperuser || session.isDeveloper)) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: "sponsor-match",
      path: PATH,
      reason: "not_developer_delete",
    });
    return editError(403, "not_developer_delete");
  }

  const { submissionId } = body;
  if (typeof submissionId !== "string" || submissionId.length === 0 || submissionId.length > 64) {
    return editError(400, "invalid_submission_id", "submissionId");
  }

  try {
    // The clicked row names the PASTE; every run of it is what gets erased.
    const row = await db.read.sponsorMatchSubmission.findUnique({
      where: { id: submissionId },
      select: { descriptionHash: true },
    });
    // Already gone is the SUCCESS case for the caller's intent but the 404 the client expects
    // (two officers clicking the same button, or a retry) — unchanged behaviour, not a 500.
    if (!row) return editError(404, "not_found");

    // deleteMany, not delete: `where` is the hash, which matches one row or many.
    const { count } = await db.write.sponsorMatchSubmission.deleteMany({
      where: { descriptionHash: row.descriptionHash },
    });
    if (count === 0) return editError(404, "not_found");
    return editOk({ deleted: submissionId, count });
  } catch (err) {
    logEditFailure(`${PATH}#delete`, err);
    return editError(502, "submissions_unavailable");
  }
}
