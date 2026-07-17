/**
 * `POST /api/edit/honor/decision` — issue #1762, the approval queue's write.
 *
 * Moves a `pending` honor to `published` or `rejected`. Gated on
 * `isSuperuser || isHonorsCurator`, mirroring `/edit/honors-queue`, and flag-gated
 * behind `HONORS_APPROVAL_QUEUE` (off ⇒ 404, like the page).
 *
 * WHY `honor_update` AND NOT A NEW `honor_approved` ACTION. Approving IS a status
 * update, and `honor_create|update|delete` are already registered in the
 * `scholars_audit` ENUM. A new action value would need the #1568 five-place ritual
 * — TS union, the SQL ENUM, a migration, and a real-DB probe with a control —
 * because `appendAuditRow` runs INSIDE this transaction and an unregistered value
 * throws MySQL 1265, rolling back EVERY decision (a 500 on 100% of writes, with
 * green tests: the #1760 near-miss). `fieldsChanged: ["status"]` plus before/after
 * records the transition, so an audit reader still sees what happened. Add
 * distinct actions only when a query needs to separate "curator approved" from
 * "scholar edited" — and pay the ritual then, deliberately.
 *
 * SIBLING REJECTION IS THE POINT, NOT A FLOURISH. Rows sharing a `sourceRef` are
 * competing candidates for ONE roster line — at most one is true. Approving one
 * therefore rejects the others IN THE SAME TRANSACTION. Left to a second call, a
 * crash between them would credit two people with one award: the mismatch this
 * project keeps naming as the expensive failure (misses are cheap).
 *
 * ONE `ts` FOR THE WHOLE DECISION. The N+1 audit rows an approval writes share a
 * single hoisted timestamp (plus the already-threaded `requestId`), which is what
 * identifies them as ONE decision rather than N unrelated edits. `ts` feeds
 * `row_hash` (`lib/edit/audit.ts`), so it must be fixed before the INSERTs, not
 * per row — the shape `core-claim/bulk` uses and the plain honor route does not
 * (it has no batch).
 *
 * TERMINALITY IS ENFORCED HERE OR NOWHERE. The migration asserts `rejected` is
 * terminal so a re-run of the feed cannot re-propose a row a human turned down,
 * but nothing in the DB enforces it: `status` is a bare ENUM with no CHECK and no
 * trigger, and all 9 transitions are legal. The `status !== "pending"` guard below
 * IS that enforcement.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { isHonorQueueEnabled } from "@/lib/edit/honor-queue";
import { editError, editOk, readEditRequest } from "@/lib/edit/request";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";

export const dynamic = "force-dynamic";

type StoredRow = {
  id: string;
  cwid: string;
  status: string;
  name: string;
  organization: string;
  year: number | null;
  /** The roster-LINE identity. Siblings share it — see the sibling note above. */
  sourceRef: string | null;
};

/** The audit before/after payload. Deliberately small: identity + what moved. */
function snapshot(row: StoredRow) {
  return {
    id: row.id,
    cwid: row.cwid,
    status: row.status,
    name: row.name,
    organization: row.organization,
    year: row.year,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isHonorQueueEnabled()) return new NextResponse(null, { status: 404 });

  // The shared preamble: origin check, identity, body parse + size limits, and the
  // requestId the audit row requires. Hand-rolling identity here would let this
  // route drift from every other /api/edit/* write.
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // Cross-scholar surface ⇒ superuser OR the honors_curator role (#1762 — the
  // Research Dean's office self-serves). Deliberately NOT a leg on
  // `authorizeOverviewWrite`, whose first leg is `self`: a scholar (or their
  // proxy) could otherwise approve the pending honor on their own profile, which
  // is the entire thing this gate exists to prevent.
  //
  // `||`, never a bare curator read — `app/api/auth/session/route.ts` reports
  // `isDeveloper: false` FOR a superuser to skip a redundant LDAPS call, and a
  // bare role read inherits that shape and locks superusers out.
  if (!session.isSuperuser && session.isHonorsCurator !== true) {
    return new NextResponse(null, { status: 403 });
  }

  const honorId = typeof body.id === "string" ? body.id : null;
  const decision =
    body.decision === "approve" || body.decision === "reject" ? body.decision : null;
  if (!honorId) return editError(400, "invalid_body", "id");
  if (!decision) return editError(400, "invalid_body", "decision");

  // Hoisted: ONE timestamp for every audit row this decision writes. See the note
  // above — per-row `new Date()` would make the N+1 rows look unrelated.
  const ts = new Date();

  try {
    const result = await db.write.$transaction(async (tx) => {
      const row = (await tx.honor.findUnique({ where: { id: honorId } })) as StoredRow | null;
      if (!row) return { kind: "not_found" as const };
      // Only a pending row is decidable, re-checked INSIDE the transaction so two
      // curators racing the same row cannot both decide it. This is also what
      // enforces `rejected` being terminal — the DB does not.
      if (row.status !== "pending") return { kind: "not_pending" as const, status: row.status };

      // A line can only be awarded ONCE. If a sibling is already `published`, this
      // row is a competing claim on an award that has been given away — approving
      // it credits TWO people with one fellowship, the exact failure the sibling
      // rejection below exists to prevent. Cannot arise while this route is the
      // only writer, but `status` has no DB guard and the Phase 2 seed is written
      // out of band, so it is guarded rather than assumed.
      if (decision === "approve" && row.sourceRef) {
        const awarded = await tx.honor.findFirst({
          where: { sourceRef: row.sourceRef, status: "published", id: { not: row.id } },
          select: { id: true },
        });
        if (awarded) return { kind: "line_already_awarded" as const };
      }

      const nextStatus = decision === "approve" ? "published" : "rejected";
      const updated = (await tx.honor.update({
        where: { id: honorId },
        data: { status: nextStatus },
      })) as StoredRow;

      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "honor",
        requestId,
        targetEntityId: row.id,
        action: "honor_update",
        fieldsChanged: ["status"],
        beforeValues: snapshot(row),
        afterValues: snapshot(updated),
        ts,
      });

      // Approving a contested line rejects its siblings, atomically. `sourceRef`
      // is the roster-LINE identity, so siblings are the other candidates for the
      // same award. A NULL sourceRef identifies no line ⇒ it has no siblings.
      // `status: "pending"` leaves an already-`rejected` sibling untouched: it is
      // terminal, and re-writing it would emit a second audit row saying nothing.
      let siblingsRejected = 0;
      // Every owner whose public profile this decision changes. Collected INSIDE
      // the transaction because siblings can belong to DIFFERENT scholars; the
      // reflection itself must happen after commit.
      const affectedCwids = new Set<string>([row.cwid]);
      if (decision === "approve" && row.sourceRef) {
        const siblings = (await tx.honor.findMany({
          where: { sourceRef: row.sourceRef, status: "pending", id: { not: row.id } },
        })) as StoredRow[];
        for (const sibling of siblings) {
          const after = (await tx.honor.update({
            where: { id: sibling.id },
            data: { status: "rejected" },
          })) as StoredRow;
          await appendAuditRow(tx, {
            actorCwid: realCwid,
            impersonatedCwid,
            targetEntityType: "honor",
            requestId,
            targetEntityId: sibling.id,
            action: "honor_update",
            fieldsChanged: ["status"],
            beforeValues: snapshot(sibling),
            afterValues: snapshot(after),
            ts,
          });
          affectedCwids.add(sibling.cwid);
          siblingsRejected++;
        }
      }
      return {
        kind: "ok" as const,
        status: nextStatus,
        siblingsRejected,
        affectedCwids: [...affectedCwids],
      };
    });

    if (result.kind === "not_found") return editError(404, "not_found", "id");
    if (result.kind === "not_pending") return editError(409, "not_pending", "id");
    if (result.kind === "line_already_awarded") {
      return editError(409, "line_already_awarded", "id");
    }

    // Post-commit, per owner. The profile page is cached and reads honors with
    // `status: published AND showOnProfile` — skip this and an approved honor
    // simply does not appear, which reads as "the approval didn't work". A
    // rejection is a reader no-op (both states are invisible), but it is reflected
    // too rather than special-cased: same cost, one code path.
    //
    // Failures here CANNOT roll the decision back — it is already committed — so
    // they must not abort the remaining owners either. Log and continue.
    await Promise.all(
      result.affectedCwids.map((cwid) =>
        reflectOwnerProfile(cwid).catch((error: unknown) => {
          console.warn(
            JSON.stringify({
              event: "honor_decision_reflect_failed",
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
 *  render on (no aggregate serializer reads `honor`). Mirrors the same helper in
 *  the sibling `app/api/edit/honor/route.ts`. */
async function reflectOwnerProfile(cwid: string): Promise<void> {
  const affected = await resolveAffectedProfiles("scholar", cwid, null);
  await reflectVisibilityChange(affected.map((a) => a.slug));
}
