/**
 * POST /api/edit/core-queue-add — "Add PMIDs → Send to review" (Core Review
 * Queue v2 PR B). A core owner puts papers they suspect used the core in front
 * of themselves for review, without deciding them yet.
 *
 * Body: `{ coreId, pmids: string[], dryRun?: true }`.
 *
 * Writes one `core_queue_add` row + one B03 audit row (`core_queue_add`) per
 * PMID, in one transaction. NOT a claim: decision 1 of the 2026-09-28 queue v2
 * assessment keeps `ClaimStatus` at `claimed | rejected`, so the queue reads
 * these rows beside `core_claim` (see `loadCoreReviewQueue`) and a later
 * Confirm/Reject is an ordinary claim on the existing routes.
 *
 * Validation is the manual-add ("Confirm now") dry run's, on the same terms:
 * the same PMID shape, the same 500 cap, the same `publication` existence probe
 * (a pmid SPS never ingested is `notFound` and not written), and a `dryRun`
 * that runs every check and stops before the transaction. What a pmid can be
 * besides "ready":
 *   - `decided` — it already has an ACTIVE claim for this core (confirmed or
 *     rejected by a person), or the engine confirmed it on its own. It is not
 *     review work; Revoke/Restore on its tab is the way back.
 *   - `inQueue` — it is already on this core's To review list: an open engine
 *     candidate, or sent here before (the UNIQUE (core_id, pmid) key).
 * Both are skipped, not errors.
 *
 * Authorization (403): the core-claim routes' rule verbatim — owner OR curator
 * of THIS core, a Superuser, or a comms_steward (`authorizeCoreClaim`).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { loadActiveCoreClaimsByCore } from "@/lib/api/core-merge";
import {
  authorizeCoreClaim,
  getCoreOwnerRole,
  logEditDenial,
  type CoreOwnerLookup,
} from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/core-queue-add";
/** Same PMID shape as the claim routes: digits, no leading zero. */
const PMID_PATTERN = /^[1-9][0-9]*$/;
/** Same cap as `POST /api/edit/core-claim/bulk` (MAX_BULK_PMIDS). */
const MAX_QUEUE_PMIDS = 500;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  // --- body shape ---
  const { coreId, pmids, dryRun } = body;
  // Strictly `true`, as on the bulk claim route.
  const isDryRun = dryRun === true;
  if (typeof coreId !== "string" || coreId.length === 0 || coreId.length > 32) {
    return editError(400, "invalid_core_id", "coreId");
  }
  if (!Array.isArray(pmids) || pmids.length === 0 || pmids.length > MAX_QUEUE_PMIDS) {
    return editError(400, "invalid_pmids", "pmids");
  }
  const uniquePmids = [...new Set(pmids)];
  if (!uniquePmids.every((p) => typeof p === "string" && PMID_PATTERN.test(p))) {
    return editError(400, "invalid_pmids", "pmids");
  }
  const targetPmids = uniquePmids as string[];

  const core = await db.read.core.findUnique({ where: { id: coreId }, select: { id: true } });
  if (!core) return editError(404, "core_not_found", "coreId");

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

  const [knownPublications, active, engineRows, queuedRows] = await Promise.all([
    db.read.publication.findMany({
      where: { pmid: { in: targetPmids } },
      select: { pmid: true },
    }),
    loadActiveCoreClaimsByCore(coreId, db.read),
    db.read.publicationCore.findMany({
      where: { coreId, pmid: { in: targetPmids } },
      select: { pmid: true, status: true },
    }),
    db.read.coreQueueAdd.findMany({
      where: { coreId, pmid: { in: targetPmids } },
      select: { pmid: true },
    }),
  ]);
  const knownPmids = new Set(knownPublications.map((p) => p.pmid));
  const engineStatus = new Map(engineRows.map((r) => [r.pmid, r.status]));
  const alreadyQueued = new Set(queuedRows.map((r) => r.pmid));

  const notFound: string[] = [];
  const toWrite: string[] = [];
  let decided = 0;
  let inQueue = 0;
  for (const pmid of targetPmids) {
    if (!knownPmids.has(pmid)) notFound.push(pmid);
    else if (active.has(pmid) || engineStatus.get(pmid) === "confirmed") decided += 1;
    else if (alreadyQueued.has(pmid) || engineStatus.get(pmid) === "candidate") inQueue += 1;
    else toWrite.push(pmid);
  }

  if (isDryRun) {
    return editOk({
      coreId,
      dryRun: true,
      added: 0,
      wouldAdd: toWrite.length,
      inQueue,
      decided,
      notFound,
    });
  }

  if (toWrite.length > 0) {
    const ts = new Date();
    try {
      await db.write.$transaction(async (tx) => {
        for (const pmid of toWrite) {
          // upsert, not create: a concurrent send of the same pmid must not
          // fail the whole batch on the UNIQUE key. The row it would have
          // written already exists, which is the outcome asked for.
          await tx.coreQueueAdd.upsert({
            where: { coreId_pmid: { coreId, pmid } },
            create: { coreId, pmid, addedBy: session.cwid, createdAt: ts },
            update: {},
          });
          await appendAuditRow(tx, {
            actorCwid: realCwid,
            impersonatedCwid,
            targetEntityType: "core",
            targetEntityId: `${coreId}:${pmid}`,
            action: "core_queue_add",
            fieldsChanged: ["queued"],
            beforeValues: null,
            afterValues: { queued: true },
            ts,
            requestId,
          });
        }
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }
  }

  return editOk({
    coreId,
    added: toWrite.length,
    inQueue,
    decided,
    notFound,
  });
}
