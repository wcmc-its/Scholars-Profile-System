/**
 * Credit a news mention to another scholar: the shared core of the queue's
 * "Wrong person? Reassign" (POST /api/edit/news-mention/decision with `cwid`)
 * and Media highlights "Add person" (POST /api/edit/news-mention/add-person).
 *
 * For each article (a story's lead, then its copies) the named scholar ends up
 * with a PUBLISHED row:
 *   - their existing published row is kept (and hidden when `hide`);
 *   - their existing pending row is approved;
 *   - otherwise a `source: "CURATOR"` row is created with the article metadata
 *     copied; a created copy points at their row for the lead.
 * A REJECTED row of theirs is never flipped: `loadTargetRows` refuses first, so
 * a refusal writes nothing. Every write is undo-stamped and audited as
 * `news_mention_update`, with `<auditKey>: <source id>` in the after-values.
 */
import type { Prisma } from "@/lib/generated/prisma/client";
import { appendAuditRow } from "@/lib/edit/audit";
import { stampFor, stampForCreated } from "@/lib/edit/news-decision";

export type StoredRow = {
  id: string;
  cwid: string;
  url: string;
  status: string;
  title: string;
  publishedAt?: Date | null;
  excerpt?: string | null;
  thumbnailUrl?: string | null;
  detectedName: string | null;
  sourceRef: string | null;
  showOnProfile: boolean;
  enteredByCwid?: string | null;
  decisionId?: string | null;
  /** Set on a Media highlights clip; only a clip can have copies. */
  outlet?: string | null;
  creditedOutlet?: string | null;
};

export function snapshot(row: StoredRow) {
  return {
    id: row.id,
    cwid: row.cwid,
    status: row.status,
    title: row.title,
    detectedName: row.detectedName,
    showOnProfile: row.showOnProfile,
  };
}

type Tx = Prisma.TransactionClient;

/**
 * The rows `target` already has for each source article, read BEFORE any write.
 * A rejected one may be the scholar's own "not me" (never overridden from the
 * queue) or a deliberate rejection, so either refuses the whole credit.
 */
export async function loadTargetRows(
  tx: Tx,
  target: string,
  sources: StoredRow[],
): Promise<
  | { kind: "ok"; rows: Map<string, StoredRow | null> }
  | { kind: "rejected_by_scholar" }
  | { kind: "target_rejected" }
> {
  const rows = new Map<string, StoredRow | null>();
  for (const source of sources) {
    const existing = (await tx.newsMention.findUnique({
      where: { cwid_url: { cwid: target, url: source.url } },
    })) as StoredRow | null;
    if (existing && existing.status === "rejected") {
      return existing.enteredByCwid === target
        ? { kind: "rejected_by_scholar" }
        : { kind: "target_rejected" };
    }
    rows.set(source.id, existing);
  }
  return { kind: "ok", rows };
}

export type CreditContext = {
  tx: Tx;
  target: string;
  /** From `loadTargetRows`. */
  targetRows: Map<string, StoredRow | null>;
  hide: boolean;
  realCwid: string;
  impersonatedCwid: string | null;
  decisionId: string;
  requestId: string;
  ts: Date;
  /** Decision ids this request re-stamps (for `invalidateDecisions`). */
  overwritten: Set<string | null | undefined>;
  /** After-values key naming the source row: "reassignedFrom" | "addedFrom". */
  auditKey: string;
};

/** Credit `ctx.target` with one article: their row's id, and whether anything
 *  was written (false when they already had it published and nothing changed).
 *  `leadId` is their row for the story's lead, which a CREATED copy points at. */
export async function creditMention(
  ctx: CreditContext,
  source: StoredRow,
  leadId: string | null,
): Promise<{ id: string; wrote: boolean }> {
  const { tx, target, hide, realCwid, impersonatedCwid, decisionId, requestId, ts } = ctx;
  const audit = (id: string, fieldsChanged: string[], before: StoredRow | null, after: object) =>
    appendAuditRow(tx, {
      actorCwid: realCwid,
      impersonatedCwid,
      targetEntityType: "news_mention",
      requestId,
      targetEntityId: id,
      action: "news_mention_update",
      fieldsChanged,
      beforeValues: before ? snapshot(before) : null,
      afterValues: { ...after, [ctx.auditKey]: source.id },
      ts,
    });

  const existing = ctx.targetRows.get(source.id) ?? null;
  if (existing && existing.status === "published") {
    // Already credited to them (e.g. VIVO-linked). Approve-but-hide still
    // hides it: the reviewer asked for the mention not to show.
    if (hide && existing.showOnProfile) {
      ctx.overwritten.add(existing.decisionId);
      const after = (await tx.newsMention.update({
        where: { id: existing.id },
        data: {
          showOnProfile: false,
          enteredByCwid: realCwid,
          ...stampFor(existing, decisionId, ts),
        },
      })) as StoredRow;
      await audit(existing.id, ["showOnProfile"], existing, snapshot(after));
      return { id: existing.id, wrote: true };
    }
    return { id: existing.id, wrote: false };
  }
  if (existing) {
    ctx.overwritten.add(existing.decisionId);
    const after = (await tx.newsMention.update({
      where: { id: existing.id },
      data: {
        status: "published",
        ...(hide ? { showOnProfile: false } : {}),
        enteredByCwid: realCwid,
        ...stampFor(existing, decisionId, ts),
      },
    })) as StoredRow;
    await audit(existing.id, hide ? ["status", "showOnProfile"] : ["status"], existing, snapshot(after));
    return { id: existing.id, wrote: true };
  }
  const created = (await tx.newsMention.create({
    data: {
      cwid: target,
      url: source.url,
      title: source.title,
      publishedAt: source.publishedAt ?? null,
      excerpt: source.excerpt ?? null,
      thumbnailUrl: source.thumbnailUrl ?? null,
      outlet: source.outlet ?? null,
      creditedOutlet: source.creditedOutlet ?? null,
      ...(leadId ? { duplicateOf: leadId } : {}),
      status: "published",
      // A human named this scholar; no name-match provenance applies.
      source: "CURATOR",
      showOnProfile: !hide,
      enteredByCwid: realCwid,
      ...stampForCreated(decisionId, ts),
    },
  })) as StoredRow;
  await audit(created.id, ["cwid", "status", "showOnProfile"], null, {
    ...snapshot(created),
    source: "CURATOR",
  });
  return { id: created.id, wrote: true };
}
