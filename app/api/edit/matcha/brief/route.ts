/**
 * `/api/edit/matcha/brief` — Matcha Phase 3 per-PI briefs (`lib/api/matcha-brief.ts`).
 *
 * GET `?submissionId=` → `{ briefs, records }` for the search's paste. Read gate = the Matcha
 *   history gate (superuser / developer / observer), scoped like Recent.
 * POST `{ submissionId, cwids[] }` → draft (or redraft) briefs, max 20. Superuser / developer
 *   ONLY: it spends Bedrock and writes rows, so an observer — who may run searches — may not.
 * PATCH `{ submissionId, cwid, why?, topics?, note? }` → the officer's edits. Same gate as POST.
 *
 * TRUST BOUNDARY: the client names a submission and PIs, nothing else. The ask's concepts and
 * each PI's matched evidence are re-read from the SAVED search (`SponsorMatchSubmission.result`);
 * a cwid absent from that result is refused. Edited topics arrive as plain TEXT — a topic keeps
 * its sources only when its text is unchanged from the generated one, so a client cannot attach
 * a source to a claim the model never grounded.
 *
 * Briefs are keyed on the PASTE (`descriptionHash`), so every run and every officer of the same
 * paste shares them. A redraft replaces `generated` and keeps `edited` and `note`.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { isMatchaEnabled } from "@/lib/api/matcha";
import {
  MAX_BRIEF_CWIDS,
  generateBrief,
  isMatchaBriefEnabled,
  loadBriefRecords,
  matchaSubmissionScope,
  type BriefEdited,
  type BriefGenerated,
  type BriefRecords,
  topicsFromTexts,
} from "@/lib/api/matcha-brief";
import type { MatchaCandidate, MatchaConcept } from "@/lib/api/matcha-contract";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import type { EditSession } from "@/lib/auth/superuser";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/matcha/brief";
/** Parallel Bedrock drafts per request. */
const CONCURRENCY = 4;
const MAX_WHY_CHARS = 2000;
const MAX_TOPIC_CHARS = 300;
const MAX_TOPICS = 5;
const MAX_NOTE_CHARS = 5000;

function enabled(): boolean {
  return isMatchaEnabled() && isMatchaBriefEnabled();
}

/** Drafting and editing spend Bedrock / write rows: superuser or developer only, never observer. */
function canWriteBriefs(session: Pick<EditSession, "isSuperuser" | "isDeveloper">): boolean {
  return session.isSuperuser || session.isDeveloper === true;
}

type StoredResult = {
  concepts: MatchaConcept[];
  candidates: MatchaCandidate[];
  titleSummary?: string;
};

/** The clicked submission (in the caller's scope) → its paste hash and display title. */
async function resolveSubmission(
  submissionId: string,
  session: Pick<EditSession, "cwid" | "isSuperuser" | "isDeveloper">,
) {
  return db.read.sponsorMatchSubmission.findUnique({
    where: { id: submissionId, ...matchaSubmissionScope(session) },
    select: { descriptionHash: true, title: true, titleOverride: true },
  });
}

/** The paste's newest stored PEOPLE answer (the grant-matcha `:elig` variant is never one). */
async function loadStoredResult(descriptionHash: string): Promise<StoredResult | null> {
  const rows = await db.read.sponsorMatchSubmission.findMany({
    where: { descriptionHash, resultKey: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { result: true, resultKey: true },
  });
  const row = rows.find((r) => r.result && !r.resultKey!.endsWith(":elig"));
  return (row?.result as StoredResult | undefined) ?? null;
}

type BriefRow = {
  cwid: string;
  generated: unknown;
  edited: unknown;
  note: string | null;
  model: string;
  createdAt: Date;
  updatedAt: Date;
};

function toWire(row: BriefRow) {
  return {
    cwid: row.cwid,
    generated: row.generated as BriefGenerated,
    edited: (row.edited ?? null) as BriefEdited | null,
    note: row.note,
    model: row.model,
    draftedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const BRIEF_SELECT = {
  cwid: true,
  generated: true,
  edited: true,
  note: true,
  model: true,
  createdAt: true,
  updatedAt: true,
} as const;

function recordsObject(map: Map<string, BriefRecords>): Record<string, BriefRecords> {
  return Object.fromEntries(map);
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!enabled()) return new NextResponse(null, { status: 404 });
  const session = await getEffectiveEditSession();
  if (!session || !(session.isSuperuser || session.isDeveloper || session.isObserver)) {
    return new NextResponse(null, { status: 403 });
  }
  const submissionId = request.nextUrl.searchParams.get("submissionId") ?? "";
  if (submissionId.length === 0 || submissionId.length > 64) {
    return editError(400, "invalid_submission_id", "submissionId");
  }
  try {
    const sub = await resolveSubmission(submissionId, session);
    if (!sub) return editError(404, "not_found");
    const rows = await db.read.matchaBrief.findMany({
      where: { descriptionHash: sub.descriptionHash },
      select: BRIEF_SELECT,
    });
    const records = await loadBriefRecords(rows.map((r) => r.cwid));
    return editOk({
      briefs: rows.map(toWire),
      records: recordsObject(records),
      canEdit: canWriteBriefs(session),
    });
  } catch (err) {
    logEditFailure(`${PATH}#get`, err);
    return editError(500, "briefs_unavailable");
  }
}

// ── POST (draft) ─────────────────────────────────────────────────────────────

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!enabled()) return new NextResponse(null, { status: 404 });
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  if (!canWriteBriefs(session)) {
    logEditDenial({ actorCwid: realCwid, targetCwid: "sponsor-match", path: PATH, reason: "not_developer_brief" });
    return editError(403, "not_developer_brief");
  }

  const { submissionId, cwids } = body;
  if (typeof submissionId !== "string" || submissionId.length === 0 || submissionId.length > 64) {
    return editError(400, "invalid_submission_id", "submissionId");
  }
  if (
    !Array.isArray(cwids) ||
    cwids.length === 0 ||
    cwids.length > MAX_BRIEF_CWIDS ||
    !cwids.every((c) => typeof c === "string" && c.length > 0 && c.length <= 32)
  ) {
    return editError(400, "invalid_cwids", "cwids");
  }
  const wanted = [...new Set(cwids as string[])];

  let sub: Awaited<ReturnType<typeof resolveSubmission>>;
  let stored: StoredResult | null;
  try {
    sub = await resolveSubmission(submissionId, session);
    if (!sub) return editError(404, "not_found");
    stored = await loadStoredResult(sub.descriptionHash);
  } catch (err) {
    logEditFailure(`${PATH}#resolve`, err);
    return editError(500, "briefs_unavailable");
  }
  // No stored answer = nothing to re-derive the evidence from. Never fall back to the client.
  if (!stored) return editError(409, "no_stored_result");
  const byCwid = new Map(stored.candidates.map((c) => [c.cwid, c]));
  const unknown = wanted.filter((c) => !byCwid.has(c));
  if (unknown.length > 0) return editError(400, "cwid_not_in_results", "cwids");

  const askTitle = sub.titleOverride ?? stored.titleSummary ?? sub.title ?? null;
  let records: Map<string, BriefRecords>;
  try {
    records = await loadBriefRecords(wanted);
  } catch (err) {
    logEditFailure(`${PATH}#records`, err);
    return editError(500, "briefs_unavailable");
  }

  const outcomes = await pool(wanted, CONCURRENCY, async (cwid) => {
    try {
      const { generated, model } = await generateBrief({
        cwid,
        askTitle,
        concepts: stored!.concepts,
        candidate: byCwid.get(cwid)!,
        records: records.get(cwid)!,
      });
      return { cwid, ok: true as const, generated, model };
    } catch (err) {
      logEditFailure(`${PATH}#generate`, err);
      return { cwid, ok: false as const };
    }
  });
  const drafted = outcomes.flatMap((o) => (o.ok ? [o] : []));
  const failed = outcomes.flatMap((o) => (o.ok ? [] : [o.cwid]));

  try {
    const hash = sub.descriptionHash;
    const rows = await db.write.$transaction(async (tx) => {
      const written: BriefRow[] = [];
      for (const o of drafted) {
        // A redraft replaces only `generated`; the officer's edits and note survive it.
        written.push(
          await tx.matchaBrief.upsert({
            where: { descriptionHash_cwid: { descriptionHash: hash, cwid: o.cwid } },
            create: {
              descriptionHash: hash,
              cwid: o.cwid,
              generated: o.generated,
              model: o.model,
              createdBy: session.cwid,
            },
            update: { generated: o.generated, model: o.model, createdBy: session.cwid, createdAt: new Date() },
            select: BRIEF_SELECT,
          }),
        );
      }
      if (drafted.length > 0) {
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "matcha_ask",
          targetEntityId: hash,
          action: "matcha_brief_generate",
          fieldsChanged: ["generated"],
          beforeValues: null,
          afterValues: {
            cwids: drafted.map((o) => o.cwid),
            drafted: drafted.length,
            failed: failed.length,
            model: drafted[0].model,
          },
          ts: new Date(),
          requestId,
        });
      }
      return written;
    });
    return editOk({
      briefs: rows.map(toWire),
      records: recordsObject(new Map(drafted.map((o) => [o.cwid, records.get(o.cwid)!]))),
      failed,
    });
  } catch (err) {
    logEditFailure(`${PATH}#write`, err);
    return editError(500, "briefs_unavailable");
  }
}

// ── PATCH (edit) ─────────────────────────────────────────────────────────────

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  if (!enabled()) return new NextResponse(null, { status: 404 });
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, body } = req.ctx;

  if (!canWriteBriefs(session)) {
    logEditDenial({ actorCwid: realCwid, targetCwid: "sponsor-match", path: PATH, reason: "not_developer_brief" });
    return editError(403, "not_developer_brief");
  }

  const { submissionId, cwid, why, topics, note } = body;
  if (typeof submissionId !== "string" || submissionId.length === 0 || submissionId.length > 64) {
    return editError(400, "invalid_submission_id", "submissionId");
  }
  if (typeof cwid !== "string" || cwid.length === 0 || cwid.length > 32) {
    return editError(400, "invalid_cwid", "cwid");
  }
  // undefined = leave as is; null = revert to generated (why/topics) or clear (note).
  if (why !== undefined && why !== null && (typeof why !== "string" || why.length > MAX_WHY_CHARS)) {
    return editError(400, "invalid_why", "why");
  }
  if (
    topics !== undefined &&
    topics !== null &&
    (!Array.isArray(topics) ||
      topics.length > MAX_TOPICS ||
      !topics.every((t) => typeof t === "string" && t.length <= MAX_TOPIC_CHARS))
  ) {
    return editError(400, "invalid_topics", "topics");
  }
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > MAX_NOTE_CHARS)) {
    return editError(400, "invalid_note", "note");
  }

  try {
    const sub = await resolveSubmission(submissionId, session);
    if (!sub) return editError(404, "not_found");
    const key = { descriptionHash_cwid: { descriptionHash: sub.descriptionHash, cwid } };
    const existing = await db.read.matchaBrief.findUnique({ where: key, select: BRIEF_SELECT });
    if (!existing) return editError(404, "brief_not_found");

    const generated = existing.generated as BriefGenerated;
    const edited: BriefEdited = { ...((existing.edited ?? {}) as BriefEdited) };
    if (why === null) delete edited.why;
    else if (typeof why === "string") {
      // Saving the generated text unchanged is a revert, not an edit.
      if (why.trim() === generated.why) delete edited.why;
      else edited.why = why.trim();
    }
    if (topics === null) delete edited.topics;
    else if (Array.isArray(topics)) {
      const next = topicsFromTexts(topics as string[], generated.topics);
      const same =
        next.length === generated.topics.length && next.every((t, i) => t === generated.topics[i]);
      if (same) delete edited.topics;
      else edited.topics = next;
    }
    const hasEdits = edited.why !== undefined || edited.topics !== undefined;

    const row = await db.write.matchaBrief.update({
      where: key,
      data: {
        edited: hasEdits ? edited : Prisma.DbNull,
        ...(note === undefined ? {} : { note: typeof note === "string" && note.trim() ? note : null }),
      },
      select: BRIEF_SELECT,
    });
    return editOk({ brief: toWire(row) });
  } catch (err) {
    logEditFailure(`${PATH}#patch`, err);
    return editError(500, "briefs_unavailable");
  }
}
