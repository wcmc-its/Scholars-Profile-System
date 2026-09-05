/**
 * POST/DELETE /api/edit/core-client — a core owner (or Superuser/comms_steward)
 * maintains the "Known clients" CWID list on `/edit/core/[coreId]/review`
 * (ReciterAI #383 / SPS #2607, CWID-only pass — the owner chose the /edit
 * panel with CWIDs only for this first pass; name-based / fuzzy resolution is
 * explicitly out of scope).
 *
 * POST body: `{ coreId: string; cwids: string[] }` — a pasted, already
 * client-parsed block. Re-parsed here too (via `parseCwidBlock`, never
 * trusting the client) so a malformed token never reaches `core_client`;
 * malformed tokens are reported back as `invalid`, not rejected outright — a
 * paste of 40 CWIDs with one typo should not throw the other 39 away.
 * Response: `{ added: Array<{cwid, name: string|null, slug: string|null}>,
 * alreadyPresent: string[], invalid: string[] }`.
 *
 * DELETE body: `{ coreId: string; cwid: string }` — soft-removes one active
 * row. `{ removed: true }`, or 404 when there is no active row for that CWID.
 *
 * Both verbs share the SAME core-claim authorization gate
 * (`getCoreOwnerRole` + `authorizeCoreClaim` from `lib/edit/authz.ts`) — this
 * is not a new permission surface, it's the existing claim-queue owner gate
 * extended to a second manual-override table on the same core.
 *
 * Each write is one MySQL transaction: upsert/soft-remove the `core_client`
 * row + a B03 audit row (`core_client_add` / `core_client_remove`,
 * `targetEntityType: "core"`, `targetEntityId: "{coreId}:{cwid}"`,
 * before/after `{ active: boolean }`), and — still inside that same
 * transaction — a re-read of the FULL active client list. That in-tx list
 * (never a separate `db.read` call) is what gets mirrored to the engine's
 * DynamoDB after the commit (`lib/cores/client-writeback.ts`, best-effort,
 * dormant-safe, never fails the write): a reader-replica read at that point
 * would race replica lag and could miss the just-added CWID or still show a
 * just-removed one. The two pre-write reads that gate what gets written
 * (`activeRows` in POST, `existing` in DELETE) go through `db.write` for the
 * same read-your-writes reason; the core-existence and name-resolution reads
 * stay on `db.read`.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { parseCwidBlock } from "@/lib/api/core-clients";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  authorizeCoreClaim,
  getCoreOwnerRole,
  logEditDenial,
  type CoreOwnerLookup,
} from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { writeBackCoreClients } from "@/lib/cores/client-writeback";

const PATH = "/api/edit/core-client";
/** Generous for a real paste; a guard so a pathological body is a 400, not an
 *  unbounded transaction (mirrors MAX_BULK_PMIDS on the claim bulk route). */
const MAX_CWIDS = 500;

/** Mirror a core's FULL active client list to the engine, best-effort. Never
 *  throws — a mirror failure must not fail the write it follows. `cwids` must
 *  come from a read taken INSIDE the write transaction (never a separate
 *  `db.read` call) — see the module comment for why. */
async function mirrorActiveClients(coreId: string, cwids: string[]): Promise<unknown> {
  return writeBackCoreClients({ coreId, cwids }).catch((err) => {
    logEditFailure(`${PATH}#writeback`, err);
    return { ok: false as const, skipped: false as const };
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  // --- body shape ---
  const { coreId, cwids } = body;
  if (typeof coreId !== "string" || coreId.length === 0 || coreId.length > 32) {
    return editError(400, "invalid_core_id", "coreId");
  }
  if (
    !Array.isArray(cwids) ||
    cwids.length === 0 ||
    cwids.length > MAX_CWIDS ||
    !cwids.every((c) => typeof c === "string")
  ) {
    return editError(400, "invalid_cwids", "cwids");
  }

  // --- the core must exist (core_client is FK-less, same ADR-005 posture as core_claim) ---
  const core = await db.read.core.findUnique({ where: { id: coreId }, select: { id: true } });
  if (!core) return editError(404, "core_not_found", "coreId");

  // --- authorization (403): owner/curator of THIS core, or a Superuser/comms_steward ---
  const coreRole = await getCoreOwnerRole(session, coreId, db.read as unknown as CoreOwnerLookup);
  const authz = authorizeCoreClaim(session, coreRole);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: coreId,
      path: PATH,
      reason: authz.reason,
      targetEntityId: coreId,
    });
    return editError(403, authz.reason);
  }

  // Re-parse server-side (never trust the client): normalize, de-dupe, and
  // split into well-formed CWIDs vs. everything else. A malformed token is
  // reported back, never written and never a reason to reject the batch.
  const { cwids: parsedCwids, invalid } = parseCwidBlock(cwids.join("\n"));

  const activeRows =
    parsedCwids.length > 0
      ? await db.write.coreClient.findMany({
          where: { coreId, cwid: { in: parsedCwids }, removedAt: null },
          select: { cwid: true },
        })
      : [];
  const activeSet = new Set(activeRows.map((r) => r.cwid.toLowerCase()));
  const toWrite = parsedCwids.filter((c) => !activeSet.has(c));
  const alreadyPresent = parsedCwids.filter((c) => activeSet.has(c));

  let writeback: unknown;
  if (toWrite.length > 0) {
    const now = new Date();
    let mirrorCwids: string[];
    try {
      mirrorCwids = await db.write.$transaction(async (tx) => {
        for (const cwid of toWrite) {
          await tx.coreClient.upsert({
            where: { coreId_cwid: { coreId, cwid } },
            create: { coreId, cwid, addedBy: session.cwid, addedAt: now },
            update: { addedBy: session.cwid, addedAt: now, removedBy: null, removedAt: null },
          });
          await appendAuditRow(tx, {
            actorCwid: realCwid,
            impersonatedCwid,
            targetEntityType: "core",
            targetEntityId: `${coreId}:${cwid}`,
            action: "core_client_add",
            fieldsChanged: ["client"],
            beforeValues: { active: false },
            afterValues: { active: true },
            ts: now,
            requestId,
          });
        }
        // Re-read the full active list from the SAME transaction — see the
        // module comment on why this must not be a separate db.read call.
        const activeAfter = await tx.coreClient.findMany({
          where: { coreId, removedAt: null },
          select: { cwid: true },
        });
        return activeAfter.map((r) => r.cwid);
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }
    // best-effort engine writeback: mirror the FULL active list read inside
    // the transaction above. Only when something actually changed (mirrors
    // the bulk-claim "nothing written → no transaction, no writeback" posture).
    writeback = await mirrorActiveClients(coreId, mirrorCwids);
  }

  // --- resolve names + slugs for the newly-added cwids only (case-insensitive,
  //     same convention as loadCoreClients — never reject a well-formed CWID
  //     for having no Scholar row, just report name/slug: null). ---
  const scholars =
    toWrite.length > 0
      ? await db.read.scholar.findMany({
          where: { cwid: { in: toWrite } },
          select: { cwid: true, preferredName: true, slug: true },
        })
      : [];
  const byLowerCwid = new Map(scholars.map((s) => [s.cwid.toLowerCase(), s]));
  const added = toWrite.map((cwid) => {
    const scholar = byLowerCwid.get(cwid);
    return { cwid, name: scholar?.preferredName ?? null, slug: scholar?.slug ?? null };
  });

  return editOk({ added, alreadyPresent, invalid, writeback });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  // --- body shape ---
  const { coreId, cwid } = body;
  if (typeof coreId !== "string" || coreId.length === 0 || coreId.length > 32) {
    return editError(400, "invalid_core_id", "coreId");
  }
  if (typeof cwid !== "string" || cwid.length === 0) {
    return editError(400, "invalid_cwid", "cwid");
  }
  // Reuse the same normalize+validate path POST uses, single-token.
  const { cwids: parsedCwids, invalid: parsedInvalid } = parseCwidBlock(cwid);
  if (parsedCwids.length !== 1 || parsedInvalid.length !== 0) {
    return editError(400, "invalid_cwid", "cwid");
  }
  const normalizedCwid = parsedCwids[0];

  // --- the core must exist ---
  const core = await db.read.core.findUnique({ where: { id: coreId }, select: { id: true } });
  if (!core) return editError(404, "core_not_found", "coreId");

  // --- authorization (403): owner/curator of THIS core, or a Superuser/comms_steward ---
  const coreRole = await getCoreOwnerRole(session, coreId, db.read as unknown as CoreOwnerLookup);
  const authz = authorizeCoreClaim(session, coreRole);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: coreId,
      path: PATH,
      reason: authz.reason,
      targetEntityId: `${coreId}:${normalizedCwid}`,
    });
    return editError(403, authz.reason);
  }

  const existing = await db.write.coreClient.findUnique({
    where: { coreId_cwid: { coreId, cwid: normalizedCwid } },
    select: { removedAt: true },
  });
  if (!existing || existing.removedAt !== null) {
    return editError(404, "client_not_found", "cwid");
  }

  const now = new Date();
  let mirrorCwids: string[];
  try {
    mirrorCwids = await db.write.$transaction(async (tx) => {
      await tx.coreClient.update({
        where: { coreId_cwid: { coreId, cwid: normalizedCwid } },
        data: { removedBy: session.cwid, removedAt: now },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "core",
        targetEntityId: `${coreId}:${normalizedCwid}`,
        action: "core_client_remove",
        fieldsChanged: ["client"],
        beforeValues: { active: true },
        afterValues: { active: false },
        ts: now,
        requestId,
      });
      // Re-read the full active list from the SAME transaction — see the
      // module comment on why this must not be a separate db.read call.
      const activeAfter = await tx.coreClient.findMany({
        where: { coreId, removedAt: null },
        select: { cwid: true },
      });
      return activeAfter.map((r) => r.cwid);
    });
  } catch (err) {
    logEditFailure(`${PATH}#remove`, err);
    return editError(500, "write_failed");
  }

  const writeback = await mirrorActiveClients(coreId, mirrorCwids);

  return editOk({ removed: true, writeback });
}
