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
 * DELETE `{ submissionId }` — remove an accidental submission the pipeline has
 * NOT consumed (`pending` / `rejected` only; a `processed` one 409s
 * `submission_processed`). DynamoDB DeleteItem + audit row.
 *
 * PATCH `{ submissionId, action: "suppress" }` — retract a PROCESSED
 * submission: `status = 'suppressed'` on the item (UpdateItem) + audit row.
 * ReciterAI's drain companion honors `suppressed` by removing the produced
 * `GRANT#` items (separate ReciterAI PR in flight); the rows then fall out of
 * SPS on the next nightly projection.
 *
 * Authorization mirrors the surface this lives on (`/edit/find-researchers`
 * and `/api/opportunities`): superuser OR development role — the queue is a
 * shared team surface, so any authorized member can clean up any row. All
 * verbs 404 while `OPPORTUNITY_URL_INTAKE` is off — the dark-ship posture; the
 * IAM grant (app-stack `TaskRoleOpportunitySubmissionPolicy`) lands with the
 * same deploy so there is no flip-before-grant window.
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
  deleteSubmission,
  findDuplicate,
  getSubmission,
  isConditionalCheckFailed,
  isOpportunityIntakeEnabled,
  listSubmissions,
  normalizeOpportunityUrl,
  putSubmission,
  suppressSubmission,
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

/**
 * The shared DELETE/PATCH preamble: flag gate → request preamble → dev-role
 * gate → `submissionId` shape → the live item (or 404). Mirrors the POST's
 * front matter so the three write verbs cannot drift.
 */
async function readSubmissionMutation(
  request: NextRequest,
  denialReason: string,
): Promise<
  | { ok: false; response: NextResponse }
  | {
      ok: true;
      submissionId: string;
      existing: NonNullable<Awaited<ReturnType<typeof getSubmission>>>;
      realCwid: string;
      impersonatedCwid: string | null;
      requestId: string;
      body: Record<string, unknown>;
    }
> {
  const req = await readEditRequest(request);
  if (!req.ok) return { ok: false, response: req.response };
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  if (!(session.isSuperuser || session.isDeveloper)) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: "opportunity-intake",
      path: PATH,
      reason: denialReason,
    });
    return { ok: false, response: editError(403, denialReason) };
  }

  const { submissionId } = body;
  if (typeof submissionId !== "string" || submissionId.length === 0 || submissionId.length > 64) {
    return { ok: false, response: editError(400, "invalid_submission_id", "submissionId") };
  }

  let existing;
  try {
    existing = await getSubmission(submissionId);
  } catch (err) {
    logEditFailure(`${PATH}#get`, err);
    return { ok: false, response: editError(502, "queue_unavailable") };
  }
  if (!existing) return { ok: false, response: editError(404, "not_found") };

  return { ok: true, submissionId, existing, realCwid, impersonatedCwid, requestId, body };
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (!isOpportunityIntakeEnabled()) return new NextResponse(null, { status: 404 });
  const mut = await readSubmissionMutation(request, "not_developer_delete");
  if (!mut.ok) return mut.response;
  const { submissionId, existing, realCwid, impersonatedCwid, requestId } = mut;

  // Only an unconsumed item may be hard-deleted; a processed one has produced
  // GRANT# rows and must go through PATCH/suppress so the drain can retract
  // them. (`suppressed` is also refused — the item IS the retraction record.)
  if (existing.status !== "pending" && existing.status !== "rejected") {
    return editError(409, "submission_processed");
  }

  // The condition expression re-checks the status atomically — the drain may
  // have processed the item between the read above and this write.
  const now = new Date();
  try {
    await deleteSubmission(submissionId);
  } catch (err) {
    if (isConditionalCheckFailed(err)) return editError(409, "submission_processed");
    logEditFailure(`${PATH}#delete`, err);
    return editError(502, "queue_write_failed");
  }
  // Same ordering contract as POST: the queue write lands first, then the
  // audit row; an audit failure returns 500 while the delete persists (loudly
  // logged — the row is gone either way, so 500 is the honest state).
  try {
    await db.write.$transaction(async (tx) => {
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "opportunity_submission",
        targetEntityId: submissionId,
        action: "opportunity_submission_delete",
        fieldsChanged: null,
        beforeValues: {
          url: existing.url,
          status: existing.status,
          note: existing.note,
          submitted_by: existing.submittedBy,
        },
        afterValues: null,
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(`${PATH}#delete-audit`, err);
    return editError(500, "write_failed");
  }

  return editOk({ submissionId });
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  if (!isOpportunityIntakeEnabled()) return new NextResponse(null, { status: 404 });
  const mut = await readSubmissionMutation(request, "not_developer_patch");
  if (!mut.ok) return mut.response;
  const { submissionId, existing, realCwid, impersonatedCwid, requestId, body } = mut;

  // Explicit action discriminator — PATCH stays extensible without a second
  // guess at what a bare `{ submissionId }` means.
  if (body.action !== "suppress") return editError(400, "invalid_action", "action");

  // Only a processed item can be suppressed: pending/rejected mistakes are
  // DELETEd outright, and a second suppress is a no-op refused loudly.
  if (existing.status !== "processed") {
    return editError(
      409,
      existing.status === "suppressed" ? "already_suppressed" : "not_processed",
    );
  }

  const now = new Date();
  try {
    await suppressSubmission(submissionId, { suppressedBy: realCwid }, { now });
  } catch (err) {
    if (isConditionalCheckFailed(err)) return editError(409, "not_processed");
    logEditFailure(`${PATH}#suppress`, err);
    return editError(502, "queue_write_failed");
  }
  try {
    await db.write.$transaction(async (tx) => {
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "opportunity_submission",
        targetEntityId: submissionId,
        action: "opportunity_submission_suppress",
        fieldsChanged: null,
        beforeValues: {
          url: existing.url,
          status: existing.status,
          produced_opportunity_ids: existing.producedOpportunityIds,
        },
        afterValues: { status: "suppressed" },
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(`${PATH}#suppress-audit`, err);
    return editError(500, "write_failed");
  }

  return editOk({ submissionId });
}
