/**
 * POST /api/edit/news-mention/add-person — Media highlights "Add person".
 *
 * Body: `{ id, cwid }`. Credits the clip `id` (and its story's copies) to one
 * more scholar, PUBLISHED and shown on their profile, without touching the
 * clip's own row: unlike "Wrong person? Reassign" (the decision route's `cwid`),
 * the matched scholar keeps it. A pending clip stays pending for its own
 * decision.
 *
 * The credit itself is `creditMention` (lib/edit/news-credit.ts), shared with
 * reassign: an existing pending row of theirs is approved, a published one is
 * kept, otherwise a `source: "CURATOR"` row is created. Refusals write nothing:
 *   - 400 `same_scholar`: the clip is already theirs;
 *   - 404: no such row; 400 `not_a_clip`: a newsroom mention (no outlet);
 *   - 409 `source_rejected`: you add people to a clip you are keeping;
 *   - 409 `contested`: pick the right candidate for the detected name first;
 *   - 422 `unknown_cwid`: no live scholar row;
 *   - 409 `rejected_by_scholar` / `target_rejected`: they (or a reviewer)
 *     already rejected this article for them, never overridden from here.
 * Undo-stamped like a decision, so the queue's status-bar Undo
 * (POST /api/edit/news-mention/undo) deletes the created rows.
 */
import { type NextRequest, NextResponse } from "next/server";

import { isCwid } from "@/lib/cwid";
import { db } from "@/lib/db";
import { creditMention, loadTargetRows, type StoredRow } from "@/lib/edit/news-credit";
import { invalidateDecisions, reflectOwners } from "@/lib/edit/news-decision";
import { isNewsQueueEnabled } from "@/lib/edit/news-queue";
import { editError, editOk, readEditRequest } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isNewsQueueEnabled()) return new NextResponse(null, { status: 404 });

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // Same gate as the decision route.
  if (
    !session.isSuperuser &&
    session.isCommsSteward !== true &&
    session.isContentEditor !== true
  ) {
    return new NextResponse(null, { status: 403 });
  }

  const mentionId = typeof body.id === "string" ? body.id : null;
  if (!mentionId) return editError(400, "invalid_body", "id");
  if (typeof body.cwid !== "string") return editError(400, "invalid_body", "cwid");
  const target = body.cwid.trim().toLowerCase();
  if (!isCwid(target)) return editError(400, "invalid_cwid", "cwid");

  const ts = new Date();
  const decisionId = requestId;

  try {
    const result = await db.write.$transaction(async (tx) => {
      const row = (await tx.newsMention.findUnique({ where: { id: mentionId } })) as StoredRow | null;
      if (!row) return { kind: "not_found" as const };
      if (!row.outlet) return { kind: "not_a_clip" as const };
      if (row.cwid === target) return { kind: "same_scholar" as const };
      if (row.status === "rejected") return { kind: "source_rejected" as const };
      if (row.status === "pending" && row.sourceRef) {
        const rival = await tx.newsMention.findFirst({
          where: { sourceRef: row.sourceRef, status: "pending", cwid: { not: row.cwid } },
          select: { id: true },
        });
        if (rival) return { kind: "contested" as const };
      }

      const scholar = await tx.scholar.findFirst({
        where: { cwid: target, deletedAt: null },
        select: { cwid: true, preferredName: true },
      });
      if (!scholar) return { kind: "unknown_cwid" as const };

      // The story's other placements that are still live travel with the lead.
      const copies = (await tx.newsMention.findMany({
        where: { duplicateOf: row.id, status: { in: ["pending", "published"] } },
      })) as StoredRow[];

      const loaded = await loadTargetRows(tx, target, [row, ...copies]);
      if (loaded.kind === "rejected_by_scholar") return { kind: "rejected_by_scholar" as const };
      if (loaded.kind === "target_rejected") return { kind: "target_rejected" as const };

      const overwritten = new Set<string | null | undefined>();
      const ctx = {
        tx,
        target,
        targetRows: loaded.rows,
        hide: false,
        realCwid,
        impersonatedCwid,
        decisionId,
        requestId,
        ts,
        overwritten,
        auditKey: "addedFrom",
      };
      const leadId = await creditMention(ctx, row, null);
      for (const copy of copies) await creditMention(ctx, copy, leadId);

      overwritten.delete(decisionId);
      await invalidateDecisions(tx, overwritten);
      return { kind: "ok" as const, added: { cwid: target, name: scholar.preferredName } };
    });

    if (result.kind === "not_found") return editError(404, "not_found", "id");
    if (result.kind === "not_a_clip") return editError(400, "not_a_clip", "id");
    if (result.kind === "same_scholar") return editError(400, "same_scholar", "cwid");
    if (result.kind === "source_rejected") return editError(409, "source_rejected", "id");
    if (result.kind === "contested") return editError(409, "contested", "id");
    if (result.kind === "unknown_cwid") return editError(422, "unknown_cwid", "cwid");
    if (result.kind === "rejected_by_scholar") return editError(409, "rejected_by_scholar", "cwid");
    if (result.kind === "target_rejected") return editError(409, "target_rejected", "cwid");

    // Post-commit: put it on their profile now (ISR + CloudFront), as an approve does.
    await reflectOwners([target], requestId);
    return editOk({ decisionId, addedTo: result.added });
  } catch {
    return editError(500, "write_failed");
  }
}
