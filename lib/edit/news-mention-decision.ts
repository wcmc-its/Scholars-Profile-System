/**
 * The decision core of the news / media highlights review queues, shared by
 * `POST /api/edit/news-mention/decision` and the operator job
 * `etl/bulk-confirm-strong`. The route keeps the flag, auth and body gates;
 * this function is everything one approve / approve_hidden / reject (with an
 * optional "wrong person" reassign) writes, inside the caller's transaction.
 * See the route's docblock for the sibling sweep, the un-reject path, the undo
 * stamp and the reassign rules.
 *
 * It returns what the caller needs after commit (`affectedCwids` for the
 * profile reflection, and the response fields). It reflects nothing itself:
 * the route reflects through Next (`revalidatePath`), which the job cannot.
 */
import type { Prisma } from "@/lib/generated/prisma/client";
import { appendAuditRow } from "@/lib/edit/audit";
import { creditMention, loadTargetRows, snapshot, type StoredRow } from "@/lib/edit/news-credit";
import { invalidateDecisions, stampFor } from "@/lib/edit/news-decision";

export type NewsDecision = "approve" | "approve_hidden" | "reject";

export type NewsDecisionResult =
  | { kind: "not_found" }
  | { kind: "not_pending" }
  | { kind: "unknown_cwid" }
  | { kind: "already_decided" }
  | { kind: "rejected_by_scholar" }
  | { kind: "target_rejected" }
  | {
      kind: "ok";
      status: "published" | "rejected";
      showOnProfile: boolean;
      siblingsRejected: number;
      reassigned: { cwid: string; name: string } | null;
      affectedCwids: string[];
    };

/**
 * Decide ONE news mention inside `tx`. `realCwid` is the human who decided; it
 * is stamped as `enteredByCwid` and as every audit row's actor. `decisionId`
 * is the undo stamp written on every row this decision touches (the route
 * passes its request id). `reassignCwid` is already shape-checked and only
 * ever set on an approval.
 */
export async function decideNewsMention(
  tx: Prisma.TransactionClient,
  args: {
    mentionId: string;
    decision: NewsDecision;
    reassignCwid: string | null;
    realCwid: string;
    impersonatedCwid: string | null;
    requestId: string;
    decisionId: string;
    ts: Date;
  },
): Promise<NewsDecisionResult> {
  const {
    mentionId,
    decision,
    reassignCwid,
    realCwid,
    impersonatedCwid,
    requestId,
    decisionId,
    ts,
  } = args;
  // `approve_hidden` is `approve` in every respect but the visibility write.
  const approving = decision !== "reject";
  const hide = decision === "approve_hidden";

  const row = (await tx.newsMention.findUnique({ where: { id: mentionId } })) as StoredRow | null;
  if (!row) return { kind: "not_found" as const };

  // Naming the row's own scholar is just an approval.
  const target = reassignCwid && reassignCwid !== row.cwid ? reassignCwid : null;

  // What this route may decide, re-checked INSIDE the transaction (race guard
  // — the DB has no CHECK). Pending in either direction, plus the un-reject
  // path: a REJECTED row may still be APPROVED (#2578 follow-up). `reject`
  // stays pending-only and `published` stays undecidable — see TERMINALITY.
  // A reassign is pending-only.
  const decidable = target
    ? row.status === "pending"
    : row.status === "pending" || (row.status === "rejected" && approving);
  if (!decidable) return { kind: "not_pending" as const };

  let targetScholar: { cwid: string; preferredName: string } | null = null;
  if (target) {
    targetScholar = await tx.scholar.findFirst({
      where: { cwid: target, deletedAt: null },
      select: { cwid: true, preferredName: true },
    });
    if (!targetScholar) return { kind: "unknown_cwid" as const };
  }

  // A detected name can only resolve to ONE scholar. If a sibling is already
  // published, this is a competing claim on a mention already given away.
  // This is also the WHOLE of un-reject case 3: approving a rejected row whose
  // sibling won would mean un-publishing that second scholar, which must be a
  // separate deliberate decision — so refuse here rather than cascade. For a
  // reassign, the target scholar's own row winning is not a competing claim.
  if (approving && row.sourceRef) {
    const taken = await tx.newsMention.findFirst({
      where: {
        sourceRef: row.sourceRef,
        status: "published",
        id: { not: row.id },
        ...(target ? { cwid: { not: target } } : {}),
      },
      select: { id: true },
    });
    if (taken) return { kind: "already_decided" as const };
  }

  // Media highlights story grouping: the other copies of this story
  // (`duplicate_of` = this row) take the same decision, each audited. Only
  // undecided copies (pending; or rejected when approving) are touched. A
  // reassign's copies follow the original row: they are rejected, and the
  // named scholar is credited with each of them too (below).
  const copyApproving = approving && !target;
  const copies = !row.outlet
    ? []
    : ((await tx.newsMention.findMany({
        where: {
          duplicateOf: row.id,
          status: copyApproving ? { in: ["pending", "rejected"] } : "pending",
        },
      })) as StoredRow[]);

  // The rows the named scholar already has for the article (and for each
  // copy), read BEFORE any write so a refusal writes nothing. A rejected one
  // is never silently flipped to published: it may be the scholar's own
  // "not me" (POST /api/edit/news-mention `reject`), which a reviewer must
  // never override, or a rejection someone made on purpose.
  let targetRows = new Map<string, StoredRow | null>();
  if (target) {
    const loaded = await loadTargetRows(tx, target, [row, ...copies]);
    if (loaded.kind === "rejected_by_scholar") return { kind: "rejected_by_scholar" as const };
    if (loaded.kind === "target_rejected") return { kind: "target_rejected" as const };
    targetRows = loaded.rows;
  }

  // Undo is all or nothing (lib/edit/news-decision.ts): a row this decision
  // re-stamps drops out of whatever decision stamped it before, so that
  // earlier decision is invalidated on every row it wrote.
  const overwritten = new Set<string | null | undefined>();

  // A reassign REJECTS the original row (see WRONG PERSON above).
  const nextStatus = approving && !target ? "published" : "rejected";
  const hideThis = hide && !target;
  overwritten.add(row.decisionId);
  const updated = (await tx.newsMention.update({
    where: { id: mentionId },
    data: {
      status: nextStatus,
      ...(hideThis ? { showOnProfile: false } : {}),
      enteredByCwid: realCwid,
      ...stampFor(row, decisionId, ts),
    },
  })) as StoredRow;

  await appendAuditRow(tx, {
    actorCwid: realCwid,
    impersonatedCwid,
    targetEntityType: "news_mention",
    requestId,
    targetEntityId: row.id,
    action: "news_mention_update",
    fieldsChanged: hideThis ? ["status", "showOnProfile"] : ["status"],
    beforeValues: snapshot(row),
    afterValues: target ? { ...snapshot(updated), reassignedTo: target } : snapshot(updated),
    ts,
  });

  for (const copy of copies) {
    overwritten.add(copy.decisionId);
    const after = (await tx.newsMention.update({
      where: { id: copy.id },
      data: {
        status: nextStatus,
        ...(hideThis ? { showOnProfile: false } : {}),
        enteredByCwid: realCwid,
        ...stampFor(copy, decisionId, ts),
      },
    })) as StoredRow;
    await appendAuditRow(tx, {
      actorCwid: realCwid,
      impersonatedCwid,
      targetEntityType: "news_mention",
      requestId,
      targetEntityId: copy.id,
      action: "news_mention_update",
      fieldsChanged: hideThis ? ["status", "showOnProfile"] : ["status"],
      beforeValues: snapshot(copy),
      afterValues: target ? { ...snapshot(after), reassignedTo: target } : snapshot(after),
      ts,
    });
  }

  // Approving a contested detected-name rejects its siblings atomically. The
  // un-reject path (case 2) lands here unchanged: still-PENDING siblings are
  // rejected, and siblings already rejected are left alone — re-writing a
  // terminal row would emit an audit row that says nothing.
  let siblingsRejected = 0;
  const affectedCwids = new Set<string>([row.cwid]);
  if (approving && row.sourceRef) {
    const siblings = (await tx.newsMention.findMany({
      where: {
        sourceRef: row.sourceRef,
        status: "pending",
        id: { not: row.id },
        // The target's own candidate row is approved below, not swept.
        ...(target ? { cwid: { not: target } } : {}),
      },
    })) as StoredRow[];
    for (const sibling of siblings) {
      overwritten.add(sibling.decisionId);
      const after = (await tx.newsMention.update({
        where: { id: sibling.id },
        data: {
          status: "rejected",
          enteredByCwid: realCwid,
          ...stampFor(sibling, decisionId, ts),
        },
      })) as StoredRow;
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "news_mention",
        requestId,
        targetEntityId: sibling.id,
        action: "news_mention_update",
        fieldsChanged: ["status"],
        beforeValues: snapshot(sibling),
        afterValues: snapshot(after),
        ts,
      });
      affectedCwids.add(sibling.cwid);
      siblingsRejected++;
    }
  }

  // Credit the named scholar.
  let reassigned: { cwid: string; name: string } | null = null;
  if (target && targetScholar) {
    affectedCwids.add(target);
    const ctx = {
      tx,
      target,
      targetRows,
      hide,
      realCwid,
      impersonatedCwid,
      decisionId,
      requestId,
      ts,
      overwritten,
      auditKey: "reassignedFrom",
    };
    const { id: leadId } = await creditMention(ctx, row, null);
    // The copies the original row carried go to the named scholar too, as
    // copies of their row for the lead: the whole story moves, not just the
    // lead's placement.
    for (const copy of copies) await creditMention(ctx, copy, leadId);
    reassigned = { cwid: target, name: targetScholar.preferredName };
  }

  overwritten.delete(decisionId);
  await invalidateDecisions(tx, overwritten);

  return {
    kind: "ok" as const,
    status: nextStatus,
    showOnProfile: updated.showOnProfile,
    siblingsRejected,
    reassigned,
    affectedCwids: [...affectedCwids],
  };
}
