/**
 * `/api/edit/matcha/pitch` — Matcha targeted messages: draft "the pitch" (what the partner is
 * looking for, 2–3 plain sentences) for the "Email individually" review queue
 * (`lib/api/matcha-pitch.ts`).
 *
 * POST `{ submissionId }` → `{ pitch, subject }`.
 * POST `{ submissionId, cwid }` → `{ bullets, idea }`: that researcher's "Why I thought of you"
 *   bullets and "One idea to discuss" sentence, rewritten in the second person from their SAVED
 *   brief (`generateEmailLines`). 404 when the paste has no brief for them.
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
  loadBriefRecords,
  loadStoredResult,
  matchaSubmissionScope,
} from "@/lib/api/matcha-brief";
import { generateEmailLines, generatePitch } from "@/lib/api/matcha-pitch";
import {
  briefAngle,
  briefAngleRole,
  briefTopics,
  briefWhy,
  type BriefEdited,
  type BriefGenerated,
} from "@/lib/edit/matcha-brief-types";
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

  const { submissionId, cwid } = body;
  if (typeof submissionId !== "string" || submissionId.length === 0 || submissionId.length > 64) {
    return editError(400, "invalid_submission_id", "submissionId");
  }
  if (cwid !== undefined && (typeof cwid !== "string" || cwid.length === 0 || cwid.length > 32)) {
    return editError(400, "invalid_cwid", "cwid");
  }

  try {
    const sub = await db.read.sponsorMatchSubmission.findUnique({
      where: { id: submissionId, ...matchaSubmissionScope(session) },
      select: { description: true, descriptionHash: true, requesterOverride: true },
    });
    if (!sub) return editError(404, "not_found");
    if (typeof cwid === "string") {
      // Briefs are keyed on the paste, so only a researcher this search drafted a brief for
      // has one: this cannot read anyone else's.
      const brief = await db.read.matchaBrief.findUnique({
        where: { descriptionHash_cwid: { descriptionHash: sub.descriptionHash, cwid } },
        select: { generated: true, edited: true },
      });
      if (!brief) return editError(404, "no_brief");
      const b = {
        generated: brief.generated as BriefGenerated,
        edited: (brief.edited ?? null) as BriefEdited | null,
      };
      const [records, scholar] = await Promise.all([
        loadBriefRecords([cwid]),
        db.read.scholar.findUnique({ where: { cwid }, select: { preferredName: true } }),
      ]);
      const r = records.get(cwid);
      const pills = b.generated.methodPills?.map((p) => p.label) ?? [];
      const lines = await generateEmailLines({
        name: scholar?.preferredName ?? "",
        role: briefAngleRole(b),
        angle: briefAngle(b),
        why: briefWhy(b),
        topics: briefTopics(b).map((t) => t.text),
        methods: pills.length > 0 ? pills : (r?.methods ?? []).slice(0, 8).map((m) => m.name),
        trialCount: r?.trialCount ?? 0,
      });
      const res = editOk(lines);
      res.headers.set("cache-control", "no-store");
      return res;
    }
    const stored = await loadStoredResult(sub.descriptionHash, []);
    const requester = sub.requesterOverride?.trim() || stored?.requester?.trim() || null;
    const drafted = await generatePitch({
      description: sub.description,
      requester,
      concepts: stored?.concepts ?? [],
    });
    const res = editOk(drafted);
    res.headers.set("cache-control", "no-store");
    return res;
  } catch (err) {
    logEditFailure(`${PATH}#post`, err);
    return editError(500, "pitch_unavailable");
  }
}
