/**
 * `/api/edit/matcha/pitch` — Matcha targeted messages: draft "the pitch" (what the partner is
 * looking for, 2–3 plain sentences) for the "Email individually" review queue
 * (`lib/api/matcha-pitch.ts`).
 *
 * POST `{ submissionId }` → `{ pitch }`.
 *
 * Gate: exactly the brief-drafting gate (superuser / developer; an observer gets 403 — it spends
 * Bedrock) behind the same `MATCHA` + `MATCHA_BRIEF` flags (404 when off). The submission must be
 * in the caller's scope (`matchaSubmissionScope`), as the contacts route.
 *
 * The ask is re-read from the SAVED search: the paste (`description`), the stored concepts and the
 * requester (the officer's correction wins over the extractor's). The client sends nothing else.
 *
 * ponytail: not persisted server-side. The officer's edited pitch lives in the dialog and in that
 * browser's localStorage (keyed by submissionId); persist it on the submission if officers need it
 * across devices.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isMatchaEnabled } from "@/lib/api/matcha";
import {
  canWriteMatchaBriefs,
  isMatchaBriefEnabled,
  loadStoredResult,
  matchaSubmissionScope,
} from "@/lib/api/matcha-brief";
import { generatePitch } from "@/lib/api/matcha-pitch";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/matcha/pitch";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(isMatchaEnabled() && isMatchaBriefEnabled()))
    return new NextResponse(null, { status: 404 });
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, body } = req.ctx;

  if (!canWriteMatchaBriefs(session)) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: "sponsor-match",
      path: PATH,
      reason: "not_developer_pitch",
    });
    return editError(403, "not_developer_pitch");
  }

  const { submissionId } = body;
  if (typeof submissionId !== "string" || submissionId.length === 0 || submissionId.length > 64) {
    return editError(400, "invalid_submission_id", "submissionId");
  }

  try {
    const sub = await db.read.sponsorMatchSubmission.findUnique({
      where: { id: submissionId, ...matchaSubmissionScope(session) },
      select: { description: true, descriptionHash: true, requesterOverride: true },
    });
    if (!sub) return editError(404, "not_found");
    const stored = await loadStoredResult(sub.descriptionHash, []);
    const requester = sub.requesterOverride?.trim() || stored?.requester?.trim() || null;
    const pitch = await generatePitch({
      description: sub.description,
      requester,
      concepts: stored?.concepts ?? [],
    });
    const res = editOk({ pitch });
    res.headers.set("cache-control", "no-store");
    return res;
  } catch (err) {
    logEditFailure(`${PATH}#post`, err);
    return editError(500, "pitch_unavailable");
  }
}
