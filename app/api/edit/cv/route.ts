/**
 * POST /api/edit/cv (scholar-CV generator, `docs/scholar-cv-generator-spec.md`).
 *
 * Assembles the scholar's structured data — the suppression-honoring public
 * `ProfilePayload`, the full `Publication` rows for the bibliography, FERPA-
 * filtered mentees, and (clinical faculty only) POPS enrichment — generates the
 * §15 research-activities paragraph ANEW via the overview/Bedrock path, then
 * reconstructs the WCM faculty CV in code (`buildWcmCv`) and streams it back as a
 * single buffered `.docx` ATTACHMENT (not JSON). The output is a copy/export
 * artifact — nothing is saved to the profile and no version row is persisted (v1).
 *
 * Authorization is the SHARED `authorizeOverviewWrite` (self OR superuser OR
 * granted proxy OR org-unit owner/curator), keyed on `realCwid`, exactly like the
 * biosketch generate route — generating a CV for a profile you cannot write would
 * be pointless, so this reuses the bio-write predicate rather than authoring one
 * that could drift.
 *
 * Flag-gated behind `EDIT_CV_EXPORT` (off ⇒ 404), default-off and staging-first.
 * The M1 research summary is best-effort: a Bedrock throw is logged and §15 falls
 * back to the template's `N/A` placeholder — it never fails the CV download.
 */
import { NextResponse, type NextRequest } from "next/server";
import { generateText } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { assembleOverviewFacts, type OverviewFacts } from "@/lib/edit/overview-facts";
import {
  DEFAULT_GENERATE_MODEL,
  modelAcceptsTemperature,
  overviewSystemPromptFor,
  buildOverviewUserPrompt,
} from "@/lib/edit/overview-generator";
import {
  DEFAULT_OVERVIEW_PARAMS,
  normalizeOverviewSelection,
  type OverviewParams,
} from "@/lib/edit/overview-params";
import { loadOverviewSelectionDeltas } from "@/lib/edit/overview-selection-store";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import { editError, editRateLimited, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { recordCvExportAttempt } from "@/lib/edit/rate-limit";
import { getScholarFullProfileBySlug, type ProfilePayload } from "@/lib/api/profile";
import { getMenteesForMentor, type MenteeChip } from "@/lib/api/mentoring";
import { filterHiddenMentees, hiddenMenteeCwids } from "@/lib/mentee-suppression";
import { fetchPops } from "@/lib/edit/pops";
import {
  buildWcmCvBuffer,
  isCvEnabled,
  type CvInput,
  type HistoricalAppointment,
  type PopsEnrichment,
  type PubForCitation,
} from "@/lib/edit/cv-export";

const PATH = "/api/edit/cv";

// The M1 generation is a single Bedrock call (a few seconds). Give the function
// headroom past the platform default, like the sibling docx-download route.
export const maxDuration = 60;

/**
 * Generate the §15 research-activities paragraph(s) ANEW from the scholar's
 * facts. Reuses the overview generator's system prompt + grounded user-turn
 * assembly (the FACTS-only, anti-hallucination contract) but takes the plain-
 * prose `generateText` path — no HTML round-trip, blank-line-separated paragraphs
 * the CV builder splits directly into docx runs. `length: "extended"` is the
 * closest band to the WCM ~300-word target (no 300 band exists; its upper bound
 * is a firm ceiling). Credentials come from the AWS SDK chain (the ECS task role's
 * existing Bedrock grant; no new IAM). A Bedrock throw propagates to the caller,
 * which treats M1 as best-effort.
 */
async function generateResearchSummary(facts: OverviewFacts): Promise<string> {
  const params: OverviewParams = { ...DEFAULT_OVERVIEW_PARAMS, voice: "third", length: "extended" };
  const modelId = process.env.OVERVIEW_GENERATE_MODEL ?? DEFAULT_GENERATE_MODEL;
  const bedrock = createAmazonBedrock({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    credentialProvider: fromNodeProviderChain(),
  });
  const { text } = await generateText({
    model: bedrock(modelId),
    system: overviewSystemPromptFor(params.promptVersion),
    prompt: buildOverviewUserPrompt(facts, params),
    ...(modelAcceptsTemperature(modelId) ? { temperature: 0.4 } : {}),
  });
  return text;
}

export async function POST(request: NextRequest): Promise<Response> {
  // Flag first — a dormant feature 404s before doing any work.
  if (!isCvEnabled()) return editError(404, "not_found");

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid } = req.ctx;

  // --- body shape (mirrors biosketch: the target cwid is `entityId`) ---
  const { entityId } = req.ctx.body;
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }

  // --- authorization: the SHARED bio-write predicate (self OR superuser OR
  //     granted proxy OR org-unit owner/curator). Keyed on `realCwid`, gated to
  //     non-impersonating for the delegated legs. ---
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

  // --- rate limit (mirrors the overview/biosketch generators): every export is
  //     a fresh Bedrock generation, so count the attempt BEFORE any assembly or
  //     gateway cost. Keyed on the TARGET scholar under the distinct `cv:`
  //     namespace, so the cap holds regardless of which authorized actor
  //     exports and never collides with the sibling generator caps. ---
  const rate = await recordCvExportAttempt(entityId);
  if (!rate.allowed) {
    console.warn(
      JSON.stringify({
        event: "cv_export_rate_limited",
        path: PATH,
        actor_cwid: session.cwid,
        target_cwid: entityId,
        count: rate.count,
        limit: rate.limit,
      }),
    );
    return editRateLimited(rate.retryAfterSeconds);
  }

  // --- assemble (DB reads). The CV's content sections all come from the
  //     suppression-honoring `ProfilePayload`; `OverviewFacts` is the M1 feedstock
  //     ONLY. Mentees re-apply the mentor's FERPA hide choices (the loader does
  //     not). POPS is fetched only for clinical faculty and is best-effort (never
  //     throws into the CV path). Any DB throw → 500 `write_failed`. ---
  let profile: ProfilePayload | null = null;
  let facts: OverviewFacts | null = null;
  let pops: PopsEnrichment | null = null;
  let mentees: MenteeChip[] = [];
  let bibliography: PubForCitation[] = [];
  let historicalAppointments: HistoricalAppointment[] = [];
  try {
    const scholar = await db.read.scholar.findUnique({
      where: { cwid: entityId },
      select: { slug: true },
    });
    if (!scholar) return editError(404, "scholar_not_found", "entityId");
    profile = await getScholarFullProfileBySlug(scholar.slug);
    if (!profile) return editError(404, "scholar_not_found", "entityId");

    // M1 feedstock — the scholar's standing curation (empty posted selection ⇒
    // the assembler default) plus the durable three-state deltas, exactly as the
    // biosketch/overview generate routes assemble it.
    const deltas = await loadOverviewSelectionDeltas(entityId);
    facts = await assembleOverviewFacts(entityId, normalizeOverviewSelection({}), { deltas });
    if (!facts) return editError(404, "scholar_not_found", "entityId");

    // POPS enrichment — clinical faculty only, zero-persist, best-effort.
    pops = profile.hasClinicalProfile ? await fetchPops(entityId).catch(() => null) : null;

    // Mentees + FERPA carve: the loader does NOT apply the mentor's hide choices,
    // so re-apply the suppression layer here (entityType="mentee",
    // entityId="{mentorCwid}:{menteeCwid}"), exactly like profile-view.tsx.
    const { mentees: menteesAll } = await getMenteesForMentor(entityId, { includeCopubs: false });
    const suppressions =
      menteesAll.length > 0
        ? await db.read.suppression.findMany({
            where: {
              entityType: "mentee",
              entityId: { startsWith: `${entityId}:` },
              contributorCwid: null,
              revokedAt: null,
            },
            select: { entityId: true },
          })
        : [];
    mentees = filterHiddenMentees(menteesAll, hiddenMenteeCwids(entityId, suppressions));

    // Bibliography — the §22 citation builder needs fields ProfilePublication
    // lacks (`fullAuthorsString`/`journalAbbrev`/`volume`/`issue`/`pages`), so
    // query `Publication` directly for the (suppression-honoring) profile pmids.
    // Iterate `profile.publications` so the year-desc order AND the suppression
    // filter are preserved (a `WHERE pmid IN (...)` does not guarantee order).
    const pmids = profile.publications.map((pub) => pub.pmid);
    const pubRows =
      pmids.length > 0
        ? await db.read.publication.findMany({
            where: { pmid: { in: pmids } },
            select: {
              pmid: true,
              title: true,
              authorsString: true,
              fullAuthorsString: true,
              journal: true,
              journalAbbrev: true,
              year: true,
              volume: true,
              issue: true,
              pages: true,
              doi: true,
              pmcid: true,
              publicationType: true,
            },
          })
        : [];
    const byPmid = new Map(pubRows.map((row) => [row.pmid, row]));
    bibliography = profile.publications
      .map((pub) => byPmid.get(pub.pmid))
      .filter((row): row is PubForCitation => row != null);

    // Historical appointments (#1323) — the CV exports ALL `ED-HISTORICAL` rows
    // regardless of `showOnProfile`, and they are NOT in the (active-only,
    // hidden-excluding) `ProfilePayload`, so load them directly here.
    const historicalRows = await db.read.appointment.findMany({
      where: { cwid: entityId, source: "ED-HISTORICAL" },
      select: { title: true, organization: true, startDate: true, endDate: true },
      orderBy: { endDate: "desc" },
    });
    historicalAppointments = historicalRows.map((a) => ({
      title: a.title,
      organization: a.organization,
      startDate: a.startDate ? a.startDate.toISOString().slice(0, 10) : null,
      endDate: a.endDate ? a.endDate.toISOString().slice(0, 10) : null,
      isActive: false,
    }));
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // Re-narrow across the try boundary (the in-try 404s already returned).
  if (!profile || !facts) return editError(404, "scholar_not_found", "entityId");

  // --- M1 research summary (best-effort). Generate anew each time; on any Bedrock
  //     throw, log and fall back to an empty summary so the builder renders the
  //     §15 `N/A` placeholder — the CV download must not fail on the LLM call. ---
  let researchSummary = "";
  try {
    researchSummary = await generateResearchSummary(facts);
  } catch (err) {
    logEditFailure(PATH, err);
  }

  // --- build the WCM CV `.docx` and stream it as an attachment. ---
  try {
    const input: CvInput = {
      profile,
      mentees,
      researchSummary,
      pops,
      bibliography,
      historicalAppointments,
    };
    const buffer = await buildWcmCvBuffer(input);
    const filename = `${profile.slug}-wcm-cv.docx`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }
}
