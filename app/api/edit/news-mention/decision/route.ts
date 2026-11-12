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
 *
 * APPROVE BUT HIDE (`decision: "approve_hidden"`). The same correctness judgement
 * as `approve` — the row becomes `published`, leaves the queue, and rejects its
 * pending siblings — plus the editorial one in the SAME write: `showOnProfile`
 * false, so it never renders on the public profile, not even for the window a
 * separate approve-then-hide would leave open. It is the existing hide, not a new
 * state: the row lands in the Approved tab as "Hidden" and is un-hidden there (or
 * on the scholar's /edit news card) via POST /api/edit/news-mention `show`.
 * Everything else — decidability, the already-decided refusal, sibling sweep,
 * reflection — is identical to `approve`, and the audit row stays
 * `news_mention_update` with `fieldsChanged: ["status", "showOnProfile"]`.
 *
 * UNDO STAMP. Every row this route writes carries the request id as
 * `decisionId` plus its pre-decision status / visibility / `enteredByCwid`
 * (lib/edit/news-decision.ts). POST /api/edit/news-mention/undo restores them.
 * The response returns `decisionId` so the queue's status bar can offer Undo.
 * A row this decision re-stamps invalidates the decision that stamped it before,
 * on every row that decision wrote, so no undo can ever be partial.
 *
 * WRONG PERSON — REASSIGN (`cwid` on an approve / approve_hidden). The reviewer
 * says the story names someone the matcher did not propose. The original row is
 * NOT moved to the new CWID: it is REJECTED, so it stays as the human-touched
 * tombstone that stops etl/news re-proposing the same wrong person next night.
 * The mention is credited to the named scholar instead:
 *   - the CWID must be a live `scholar` row (`deletedAt: null`), else 422
 *     `unknown_cwid` and nothing is written;
 *   - if that scholar already has a PENDING row for the article (e.g. they were
 *     one of the contested candidates), that row is approved; if it is already
 *     published, it stays published (and `approve_hidden` hides it);
 *   - if that row is REJECTED, nothing is written: 409 `rejected_by_scholar`
 *     when the scholar rejected it themselves ("not me" — never overridden from
 *     the queue), else 409 `target_rejected`;
 *   - otherwise a new `source: "CURATOR"` row is created with the article
 *     metadata copied and no name-match provenance.
 * A Media highlights lead's pending copies (`duplicate_of`) move with it: each
 * is rejected with the original and credited to the named scholar the same
 * way, a created copy pointing at the scholar's row for the lead.
 * The pending siblings of a contested name are swept to rejected exactly as an
 * approve would (none of them was the right person), a sibling already
 * published is the same `already_decided` 409, and only a PENDING row can be
 * reassigned. Audited as `news_mention_update` (no new ENUM value), with
 * `reassignedTo` / `reassignedFrom` in the after-values.
 */
import { type NextRequest, NextResponse } from "next/server";

import { isCwid } from "@/lib/cwid";
import { db } from "@/lib/db";
import { reflectOwners } from "@/lib/edit/news-decision";
import { decideNewsMention } from "@/lib/edit/news-mention-decision";
import { isNewsQueueEnabled } from "@/lib/edit/news-queue";
import { editError, editOk, readEditRequest } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isNewsQueueEnabled()) return new NextResponse(null, { status: 404 });

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // Cross-scholar surface ⇒ superuser OR comms_steward. `||`, never a bare role
  // read — the session route reports role booleans false FOR a superuser.
  // A content editor works the news queues too (`lib/auth/content-editor.ts`).
  if (
    !session.isSuperuser &&
    session.isCommsSteward !== true &&
    session.isContentEditor !== true
  ) {
    return new NextResponse(null, { status: 403 });
  }

  const mentionId = typeof body.id === "string" ? body.id : null;
  const decision =
    body.decision === "approve" ||
    body.decision === "approve_hidden" ||
    body.decision === "reject"
      ? body.decision
      : null;
  if (!mentionId) return editError(400, "invalid_body", "id");
  if (!decision) return editError(400, "invalid_body", "decision");

  // `approve_hidden` is `approve` in every respect but the visibility write.
  const approving = decision !== "reject";

  // Optional "wrong person" target. Only an approval can name one: rejecting
  // "for" someone else means nothing.
  let reassignCwid: string | null = null;
  if (body.cwid !== undefined && body.cwid !== null) {
    if (typeof body.cwid !== "string") return editError(400, "invalid_body", "cwid");
    const cwid = body.cwid.trim().toLowerCase();
    if (!isCwid(cwid)) return editError(400, "invalid_cwid", "cwid");
    if (!approving) return editError(400, "invalid_body", "cwid");
    reassignCwid = cwid;
  }

  // One timestamp for every audit row this decision writes, and the undo stamp's
  // decision id (the request id is a fresh uuid per request).
  const ts = new Date();
  const decisionId = requestId;

  try {
    const result = await db.write.$transaction(async (tx) => {
      // The decision itself: the shared core (lib/edit/news-mention-decision.ts),
      // also run by the etl/bulk-confirm-strong operator job.
      return decideNewsMention(tx, {
        mentionId,
        decision,
        reassignCwid,
        realCwid,
        impersonatedCwid,
        requestId,
        decisionId,
        ts,
      });
    });

    if (result.kind === "not_found") return editError(404, "not_found", "id");
    if (result.kind === "not_pending") return editError(409, "not_pending", "id");
    if (result.kind === "already_decided") return editError(409, "already_decided", "id");
    if (result.kind === "unknown_cwid") return editError(422, "unknown_cwid", "cwid");
    if (result.kind === "rejected_by_scholar") {
      return editError(409, "rejected_by_scholar", "cwid");
    }
    if (result.kind === "target_rejected") return editError(409, "target_rejected", "cwid");

    // Post-commit, per owner. An approval that skips this simply doesn't appear on
    // the profile, which reads as "the approval didn't work". Failures here cannot
    // roll the committed decision back, so log and continue.
    await reflectOwners(result.affectedCwids, requestId);

    return editOk({
      status: result.status,
      showOnProfile: result.showOnProfile,
      siblingsRejected: result.siblingsRejected,
      decisionId,
      ...(result.reassigned ? { reassignedTo: result.reassigned } : {}),
    });
  } catch {
    return editError(500, "write_failed");
  }
}
