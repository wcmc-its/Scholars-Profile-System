/**
 * POST /api/edit/news-mention/group — change which Media highlights clips are
 * copies of one story (`news_mention.duplicate_of`, lib/edit/clip-repeats.ts).
 *
 * Body: `{ op, id, leadId? }`
 *   - `ungroup`: `id` stops being a copy (becomes its own story).
 *   - `make_lead`: `id` (a copy) becomes the story's lead; the old lead and the
 *     other copies point at it.
 *   - `group`: `id` becomes a copy of `leadId`'s story (same scholar). If `id`
 *     was itself a lead, its copies move with it.
 *
 * Same gate as the queue decision route (superuser or comms steward, queue flag
 * on). Every changed row gets a `news_mention_update` audit row with
 * `fields_changed=["duplicateOf"]` — no new audit action/ENUM needed. Writes and
 * the reads that decide them run on the writer inside one transaction.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { isMediaHighlightsQueueEnabled } from "@/lib/edit/news-queue";
import { editError, editOk, readEditRequest } from "@/lib/edit/request";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";

export const dynamic = "force-dynamic";

type Clip = { id: string; cwid: string; outlet: string | null; duplicateOf: string | null };
const SELECT = { id: true, cwid: true, outlet: true, duplicateOf: true } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isMediaHighlightsQueueEnabled()) return new NextResponse(null, { status: 404 });

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;
  if (!session.isSuperuser && session.isCommsSteward !== true) {
    return new NextResponse(null, { status: 403 });
  }

  const op = body.op === "ungroup" || body.op === "make_lead" || body.op === "group" ? body.op : null;
  const id = typeof body.id === "string" ? body.id : null;
  const leadId = typeof body.leadId === "string" ? body.leadId : null;
  if (!op) return editError(400, "invalid_body", "op");
  if (!id) return editError(400, "invalid_body", "id");
  if (op === "group" && !leadId) return editError(400, "invalid_body", "leadId");
  const ts = new Date();

  try {
    const result = await db.write.$transaction(async (tx) => {
      const row = (await tx.newsMention.findUnique({ where: { id }, select: SELECT })) as Clip | null;
      if (!row || row.outlet === null) return { kind: "not_found" as const };

      /** Target duplicateOf per row id; applied + audited below. */
      const next = new Map<string, string | null>();
      if (op === "ungroup") {
        if (row.duplicateOf === null) return { kind: "noop" as const };
        next.set(row.id, null);
      } else if (op === "make_lead") {
        const oldLead = row.duplicateOf;
        if (oldLead === null) return { kind: "noop" as const };
        next.set(row.id, null);
        next.set(oldLead, row.id);
        const siblings = await tx.newsMention.findMany({ where: { duplicateOf: oldLead }, select: SELECT });
        for (const s of siblings) if (s.id !== row.id) next.set(s.id, row.id);
      } else {
        const target = (await tx.newsMention.findUnique({ where: { id: leadId! }, select: SELECT })) as Clip | null;
        if (!target || target.outlet === null || target.cwid !== row.cwid) {
          return { kind: "bad_target" as const };
        }
        const lead = target.duplicateOf ?? target.id;
        if (lead === row.id || row.duplicateOf === lead) return { kind: "noop" as const };
        next.set(row.id, lead);
        const copies = await tx.newsMention.findMany({ where: { duplicateOf: row.id }, select: SELECT });
        for (const c of copies) next.set(c.id, lead);
      }

      for (const [rowId, duplicateOf] of next) {
        const before = (await tx.newsMention.findUnique({ where: { id: rowId }, select: SELECT })) as Clip;
        await tx.newsMention.update({ where: { id: rowId }, data: { duplicateOf } });
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "news_mention",
          requestId,
          targetEntityId: rowId,
          action: "news_mention_update",
          fieldsChanged: ["duplicateOf"],
          beforeValues: { id: rowId, cwid: before.cwid, duplicateOf: before.duplicateOf, op },
          afterValues: { id: rowId, cwid: before.cwid, duplicateOf },
          ts,
        });
      }
      return { kind: "ok" as const, cwid: row.cwid, changed: next.size };
    });

    if (result.kind === "not_found") return editError(404, "not_found", "id");
    if (result.kind === "bad_target") return editError(400, "invalid_body", "leadId");
    if (result.kind === "noop") return editOk({ changed: 0 });

    // The profile shows one entry per story, so a regroup can change it.
    await resolveAffectedProfiles("scholar", result.cwid, null)
      .then((affected) => reflectVisibilityChange(affected.map((a) => a.slug)))
      .catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            event: "news_group_reflect_failed",
            cwid: result.cwid,
            requestId,
            reason: error instanceof Error ? error.message : "unknown",
          }),
        );
      });
    return editOk({ changed: result.changed });
  } catch {
    return editError(500, "write_failed");
  }
}
