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
import { askTitleFrom } from "@/lib/api/matcha-contract";
import {
  MAX_BRIEF_CWIDS,
  generateBrief,
  isMatchaBriefEnabled,
  loadBriefRecords,
  loadStoredResult,
  matchaSubmissionScope,
  type StoredResult,
  type BriefEdited,
  type BriefGenerated,
  type BriefRecords,
  topicsFromTexts,
  withLiveSources,
} from "@/lib/api/matcha-brief";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import type { EditSession } from "@/lib/auth/superuser";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import {
  editError,
  editOk,
  editOkStream,
  logEditFailure,
  readEditRequest,
} from "@/lib/edit/request";

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

type BriefRow = {
  cwid: string;
  generated: unknown;
  edited: unknown;
  note: string | null;
  model: string;
  createdAt: Date;
  updatedAt: Date;
};

function toWire(row: BriefRow, records?: BriefRecords) {
  const generated = row.generated as BriefGenerated;
  const edited = (row.edited ?? null) as BriefEdited | null;
  return {
    cwid: row.cwid,
    generated: records
      ? { ...generated, topics: withLiveSources(generated.topics, records) }
      : generated,
    edited:
      records && edited?.topics
        ? { ...edited, topics: withLiveSources(edited.topics, records) }
        : edited,
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
      // Sources re-checked against TODAY's records: an award suppressed (or hideFunding set)
      // after drafting must not keep riding on the wire as a brief's source.
      briefs: rows.map((r) => toWire(r, records.get(r.cwid))),
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
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
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
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: "sponsor-match",
      path: PATH,
      reason: "not_developer_brief",
    });
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
  let records: Map<string, BriefRecords>;
  try {
    sub = await resolveSubmission(submissionId, session);
    if (!sub) return editError(404, "not_found");
    stored = await loadStoredResult(sub.descriptionHash, wanted);
    // No stored answer = nothing to re-derive the evidence from. Never fall back to the client.
    if (!stored) return editError(409, "no_stored_result");
    if (!wanted.every((c) => stored!.candidates.some((k) => k.cwid === c))) {
      return editError(400, "cwid_not_in_results", "cwids");
    }
    records = await loadBriefRecords(wanted);
  } catch (err) {
    logEditFailure(`${PATH}#resolve`, err);
    return editError(500, "briefs_unavailable");
  }
  const answer = stored;
  const byCwid = new Map(answer.candidates.map((c) => [c.cwid, c]));
  const hash = sub.descriptionHash;
  // The GENERATED title, never the officer's Rename: the prompt must not carry free text a
  // (possibly different, possibly observer) officer typed, and two officers' renames of the same
  // paste must not draft different briefs.
  // The MODEL's requester composes the same way the generated title does ("{requester} — {focus}").
  const askTitle = answer.titleSummary
    ? (askTitleFrom([], [], answer.titleSummary, answer.requester)?.title ?? null)
    : (sub.title ?? null);

  /** Draft one PI, then persist its row + audit entry in ONE transaction. Never throws. */
  const draftOne = async (cwid: string) => {
    let drafted: Awaited<ReturnType<typeof generateBrief>>;
    try {
      drafted = await generateBrief({
        cwid,
        askTitle,
        concepts: answer.concepts,
        candidate: byCwid.get(cwid)!,
        records: records.get(cwid)!,
      });
    } catch (err) {
      logEditFailure(`${PATH}#generate`, err);
      return { cwid, ok: false as const };
    }
    try {
      const row = await db.write.$transaction(async (tx) => {
        // A redraft replaces only `generated`; the officer's edits and note survive it.
        const written = await tx.matchaBrief.upsert({
          where: { descriptionHash_cwid: { descriptionHash: hash, cwid } },
          create: {
            descriptionHash: hash,
            cwid,
            generated: drafted.generated,
            model: drafted.model,
            createdBy: session.cwid,
          },
          update: {
            generated: drafted.generated,
            model: drafted.model,
            createdBy: session.cwid,
            createdAt: new Date(),
          },
          select: BRIEF_SELECT,
        });
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "matcha_ask",
          targetEntityId: hash,
          action: "matcha_brief_generate",
          fieldsChanged: ["generated"],
          beforeValues: null,
          afterValues: { cwid, model: drafted.model, removedCount: drafted.generated.removedCount },
          ts: new Date(),
          requestId,
        });
        return written;
      });
      return { cwid, ok: true as const, brief: toWire(row), records: records.get(cwid)! };
    } catch (err) {
      logEditFailure(`${PATH}#write`, err);
      return { cwid, ok: false as const };
    }
  };

  // STREAMED (NDJSON + the padded heartbeat): draft + fact-check + revise for one PI can pass
  // CloudFront's 30s origin-read timeout on /api/edit*, and a silent response is reset at 30s.
  // Each PI's line is emitted as it lands, so the console fills rows as they arrive.
  return editOkStream(
    async (emit) => {
      const outcomes = await pool(wanted, CONCURRENCY, async (cwid) => {
        const o = await draftOne(cwid);
        emit(o.ok ? { cwid, ok: true, brief: o.brief, records: o.records } : { cwid, ok: false });
        return o;
      });
      return {
        briefs: outcomes.flatMap((o) => (o.ok ? [o.brief] : [])),
        records: Object.fromEntries(outcomes.flatMap((o) => (o.ok ? [[o.cwid, o.records]] : []))),
        failed: outcomes.flatMap((o) => (o.ok ? [] : [o.cwid])),
      };
    },
    (err) => {
      logEditFailure(`${PATH}#stream`, err);
      return { error: "briefs_unavailable" };
    },
  ) as NextResponse;
}

// ── PATCH (edit) ─────────────────────────────────────────────────────────────

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  if (!enabled()) return new NextResponse(null, { status: 404 });
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, body } = req.ctx;

  if (!canWriteBriefs(session)) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: "sponsor-match",
      path: PATH,
      reason: "not_developer_brief",
    });
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
  if (
    why !== undefined &&
    why !== null &&
    (typeof why !== "string" || why.length > MAX_WHY_CHARS)
  ) {
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
  if (
    note !== undefined &&
    note !== null &&
    (typeof note !== "string" || note.length > MAX_NOTE_CHARS)
  ) {
    return editError(400, "invalid_note", "note");
  }

  try {
    const sub = await resolveSubmission(submissionId, session);
    if (!sub) return editError(404, "not_found");
    const key = { descriptionHash_cwid: { descriptionHash: sub.descriptionHash, cwid } };
    // Read-modify-write of `edited` on the WRITER, in one transaction: a replica read could miss a
    // just-drafted row (false 404) or a just-saved edit (the next save would overwrite it).
    const row = await db.write.$transaction(async (tx) => {
      const existing = await tx.matchaBrief.findUnique({ where: key, select: BRIEF_SELECT });
      if (!existing) return null;

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
          next.length === generated.topics.length &&
          next.every((t, i) => t === generated.topics[i]);
        if (same) delete edited.topics;
        else edited.topics = next;
      }
      const hasEdits = edited.why !== undefined || edited.topics !== undefined;

      return tx.matchaBrief.update({
        where: key,
        data: {
          edited: hasEdits ? edited : Prisma.DbNull,
          ...(note === undefined
            ? {}
            : { note: typeof note === "string" && note.trim() ? note : null }),
        },
        select: BRIEF_SELECT,
      });
    });
    if (!row) return editError(404, "brief_not_found");
    return editOk({ brief: toWire(row) });
  } catch (err) {
    logEditFailure(`${PATH}#patch`, err);
    return editError(500, "briefs_unavailable");
  }
}
