/**
 * `/api/edit/opportunity-intake` — submit a funding-opportunity URL for the
 * ReciterAI pipeline, and list what's been submitted
 * (`docs/opportunity-url-intake-spec.md` §5).
 *
 * POST `{ url, note? }` — validate + dedup, then append a `SUBMISSION` queue
 * item to the shared `reciterai` DynamoDB table and a B03 audit row. SPS never
 * fetches the URL and never writes the corpus: ReciterAI's
 * `ingest_submissions` drain does the scrape/extract/score/persist, and the
 * result arrives through the ordinary nightly projection.
 *
 * GET — the whole queue, newest-first, so the team sees each other's
 * submissions (and their processed/rejected outcomes) instead of re-submitting.
 *
 * Authorization mirrors the surface this lives on (`/edit/find-researchers`
 * and `/api/opportunities`): superuser OR development role. Both verbs 404
 * while `OPPORTUNITY_URL_INTAKE` is off — the dark-ship posture; the IAM grant
 * (app-stack `TaskRoleOpportunitySubmissionPolicy`) lands with the same deploy
 * so there is no flip-before-grant window.
 *
 * Audit ordering: the DynamoDB Put is not transactional with the MySQL audit
 * INSERT, so the Put lands first and the audit append follows. If the audit
 * INSERT fails the route returns 500 while the queue item persists — a retry
 * then 409s against the caller's own item, which is the honest state; the gap
 * is loudly logged either way.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import {
  findDuplicate,
  isOpportunityIntakeEnabled,
  listSubmissions,
  normalizeOpportunityUrl,
  putSubmission,
} from "@/lib/edit/opportunity-submission";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/opportunity-intake";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!isOpportunityIntakeEnabled()) return new NextResponse(null, { status: 404 });
  const session = await getEffectiveEditSession();
  if (!session || !(session.isSuperuser || session.isDeveloper)) {
    return new NextResponse(null, { status: 403 });
  }
  try {
    return editOk({ submissions: await listSubmissions() });
  } catch (err) {
    logEditFailure(`${PATH}#list`, err);
    return editError(502, "queue_unavailable");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isOpportunityIntakeEnabled()) return new NextResponse(null, { status: 404 });
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  if (!(session.isSuperuser || session.isDeveloper)) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: "opportunity-intake",
      path: PATH,
      reason: "not_developer_post",
    });
    return editError(403, "not_developer_post");
  }

  // --- body shape ---
  const { url, note } = body;
  if (typeof url !== "string") return editError(400, "invalid_url", "url");
  const normalized = normalizeOpportunityUrl(url);
  if (!normalized.ok) return editError(400, normalized.error, "url");
  const noteValue =
    typeof note === "string" && note.trim().length > 0 ? note.trim().slice(0, 500) : null;

  // --- dedup (spec §7 submit-time layer): the projected corpus + the queue ---
  let existingSubmissions;
  try {
    existingSubmissions = await listSubmissions();
  } catch (err) {
    logEditFailure(`${PATH}#dedup-list`, err);
    return editError(502, "queue_unavailable");
  }
  const corpus = await db.read.opportunity.findMany({
    select: { opportunityId: true, title: true, sourceUrl: true },
  });
  const duplicate = findDuplicate(normalized.normalized, corpus, existingSubmissions);
  if (duplicate.opportunity) {
    return NextResponse.json(
      { ok: false, error: "duplicate_url", existing: duplicate.opportunity },
      { status: 409 },
    );
  }
  if (duplicate.submission) {
    return NextResponse.json(
      { ok: false, error: "duplicate_submission", existing: duplicate.submission },
      { status: 409 },
    );
  }

  // --- queue write (the manual-layer write), then the B03 audit row ---
  const now = new Date();
  let submission;
  try {
    submission = await putSubmission(
      {
        url: url.trim(),
        normalizedUrl: normalized.normalized,
        note: noteValue,
        submittedBy: session.cwid,
      },
      { now },
    );
  } catch (err) {
    logEditFailure(`${PATH}#put`, err);
    return editError(502, "queue_write_failed");
  }
  try {
    await db.write.$transaction(async (tx) => {
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "opportunity_submission",
        targetEntityId: submission.submissionId,
        action: "opportunity_submission",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: { url: submission.url, note: noteValue },
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(`${PATH}#audit`, err);
    return editError(500, "write_failed");
  }

  return editOk({ submission });
}
