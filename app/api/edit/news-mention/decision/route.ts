/**
 * `POST /api/edit/news-mention/decision` — the news approval queue's write.
 *
 * Moves a `pending` NAME-matched mention to `published` or `rejected`, and an
 * already-`rejected` one back to `published` (#2578 follow-up — see TERMINALITY).
 * Gated on `isSuperuser || isCommsSteward` (external comms IS the comms-steward
 * function), and flag-gated behind `NEWS_APPROVAL_QUEUE` (off ⇒ 404, like the page).
 * Deliberately NOT a leg on `authorizeOverviewWrite`, whose first leg is `self`:
 * a scholar could otherwise approve a pending mention onto their own profile,
 * which is the whole point of a human-confirmation gate on a name match.
 *
 * WHY `news_mention_update` AND NOT A NEW ACTION. Approving IS a status update,
 * and `news_mention_update` is already registered in the `scholars_audit` ENUM.
 * A new value would need the five-place ritual (TS union, both SQL ENUMs, the
 * ALTERs, a real-DB probe), because `appendAuditRow` runs INSIDE this transaction
 * and an unregistered value throws MySQL 1265 — a 500 on EVERY decision.
 * `fieldsChanged: ["status"]` + before/after records the transition.
 *
 * SIBLING REJECTION. Rows sharing a `sourceRef` (`<url>|<foldedName>`) are the
 * competing scholars a single prose name resolved to — at most one is right.
 * Approving one therefore rejects the others IN THE SAME TRANSACTION, or a crash
 * between two calls would credit two people with one mention. One hoisted `ts`
 * ties the N+1 audit rows as ONE decision (`ts` feeds `row_hash`).
 *
 * TERMINALITY — HALF OF IT SURVIVES (#2578 follow-up). `rejected` is terminal
 * against the ETL and NOT against a human reviewer; only the first half was ever
 * the point. Against the ETL: every decision sets `entered_by_cwid`, which marks
 * the row human-touched, and etl/news never reverts such a row — so a re-scrape
 * still cannot re-propose something a human turned down. That invariant is
 * untouched, and it is precisely what makes un-rejecting safe.
 *
 * Against a reviewer, `rejected` is no longer terminal: comms needs a "whoops,
 * that WAS the right person" path off the Rejected tab, so `approve` is allowed on
 * a `rejected` row in three cases —
 *   1. UNCONTESTED (no `sourceRef`, or nobody else shares it): approve. One person
 *      moves; this is the common case.
 *   2. CONTESTED with NO sibling published: approve, and reject the still-PENDING
 *      siblings exactly as the pending path does. (The queue warns before the
 *      click; the route does not re-litigate it.)
 *   3. CONTESTED with a sibling ALREADY published: REFUSE (`already_decided` ⇒
 *      409). Approving would have to un-publish a SECOND scholar's row, and that
 *      has to be its own deliberate decision, never a silent side effect of this
 *      one. No new code implements this — the "already given away" pre-check
 *      below IS case 3, unchanged.
 * `reject` stays pending-only (re-rejecting writes an audit row that says
 * nothing), and `published` stays undecidable in both directions — un-publishing
 * is the profile card's `hide`/`reject` on POST /api/edit/news-mention. The status
 * re-check still lives INSIDE the transaction: nothing in the DB constrains these
 * transitions (bare ENUM, no CHECK), and it is also the race guard for two
 * reviewers hitting one row.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { isNewsQueueEnabled } from "@/lib/edit/news-queue";
import { editError, editOk, readEditRequest } from "@/lib/edit/request";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";

export const dynamic = "force-dynamic";

type StoredRow = {
  id: string;
  cwid: string;
  status: string;
  title: string;
  detectedName: string | null;
  sourceRef: string | null;
};

function snapshot(row: StoredRow) {
  return {
    id: row.id,
    cwid: row.cwid,
    status: row.status,
    title: row.title,
    detectedName: row.detectedName,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isNewsQueueEnabled()) return new NextResponse(null, { status: 404 });

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // Cross-scholar surface ⇒ superuser OR comms_steward. `||`, never a bare role
  // read — the session route reports role booleans false FOR a superuser.
  if (!session.isSuperuser && session.isCommsSteward !== true) {
    return new NextResponse(null, { status: 403 });
  }

  const mentionId = typeof body.id === "string" ? body.id : null;
  const decision =
    body.decision === "approve" || body.decision === "reject" ? body.decision : null;
  if (!mentionId) return editError(400, "invalid_body", "id");
  if (!decision) return editError(400, "invalid_body", "decision");

  // One timestamp for every audit row this decision writes.
  const ts = new Date();

  try {
    const result = await db.write.$transaction(async (tx) => {
      const row = (await tx.newsMention.findUnique({ where: { id: mentionId } })) as StoredRow | null;
      if (!row) return { kind: "not_found" as const };
      // What this route may decide, re-checked INSIDE the transaction (race guard
      // — the DB has no CHECK). Pending in either direction, plus the un-reject
      // path: a REJECTED row may still be APPROVED (#2578 follow-up). `reject`
      // stays pending-only and `published` stays undecidable — see TERMINALITY.
      const decidable =
        row.status === "pending" || (row.status === "rejected" && decision === "approve");
      if (!decidable) return { kind: "not_pending" as const };

      // A detected name can only resolve to ONE scholar. If a sibling is already
      // published, this is a competing claim on a mention already given away.
      // This is also the WHOLE of un-reject case 3: approving a rejected row whose
      // sibling won would mean un-publishing that second scholar, which must be a
      // separate deliberate decision — so refuse here rather than cascade.
      if (decision === "approve" && row.sourceRef) {
        const taken = await tx.newsMention.findFirst({
          where: { sourceRef: row.sourceRef, status: "published", id: { not: row.id } },
          select: { id: true },
        });
        if (taken) return { kind: "already_decided" as const };
      }

      const nextStatus = decision === "approve" ? "published" : "rejected";
      const updated = (await tx.newsMention.update({
        where: { id: mentionId },
        data: { status: nextStatus, enteredByCwid: realCwid },
      })) as StoredRow;

      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "news_mention",
        requestId,
        targetEntityId: row.id,
        action: "news_mention_update",
        fieldsChanged: ["status"],
        beforeValues: snapshot(row),
        afterValues: snapshot(updated),
        ts,
      });

      // Approving a contested detected-name rejects its siblings atomically. The
      // un-reject path (case 2) lands here unchanged: still-PENDING siblings are
      // rejected, and siblings already rejected are left alone — re-writing a
      // terminal row would emit an audit row that says nothing.
      let siblingsRejected = 0;
      const affectedCwids = new Set<string>([row.cwid]);
      if (decision === "approve" && row.sourceRef) {
        const siblings = (await tx.newsMention.findMany({
          where: { sourceRef: row.sourceRef, status: "pending", id: { not: row.id } },
        })) as StoredRow[];
        for (const sibling of siblings) {
          const after = (await tx.newsMention.update({
            where: { id: sibling.id },
            data: { status: "rejected", enteredByCwid: realCwid },
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
      return { kind: "ok" as const, status: nextStatus, siblingsRejected, affectedCwids: [...affectedCwids] };
    });

    if (result.kind === "not_found") return editError(404, "not_found", "id");
    if (result.kind === "not_pending") return editError(409, "not_pending", "id");
    if (result.kind === "already_decided") return editError(409, "already_decided", "id");

    // Post-commit, per owner. An approval that skips this simply doesn't appear on
    // the profile, which reads as "the approval didn't work". Failures here cannot
    // roll the committed decision back, so log and continue.
    await Promise.all(
      result.affectedCwids.map((cwid) =>
        reflectOwnerProfile(cwid).catch((error: unknown) => {
          console.warn(
            JSON.stringify({
              event: "news_decision_reflect_failed",
              cwid,
              requestId,
              reason: error instanceof Error ? error.message : "unknown",
            }),
          );
        }),
      ),
    );

    return editOk({ status: result.status, siblingsRejected: result.siblingsRejected });
  } catch {
    return editError(500, "write_failed");
  }
}

/** Reflect one owner's profile page post-commit — the only surface these rows
 *  render on (no aggregate serializer reads `news_mention`). */
async function reflectOwnerProfile(cwid: string): Promise<void> {
  const affected = await resolveAffectedProfiles("scholar", cwid, null);
  await reflectVisibilityChange(affected.map((a) => a.slug));
}
