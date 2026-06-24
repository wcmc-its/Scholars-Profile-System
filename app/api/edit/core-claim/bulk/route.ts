/**
 * POST /api/edit/core-claim/bulk — a core owner (or Superuser) claims or rejects
 * MANY (publication, core) candidates in one request.
 *
 * Body: `{ coreId, pmids: string[], status: "claimed" | "rejected" }`.
 *
 * The scale companion to `POST /api/edit/core-claim`: the single route is fanned
 * out client-side one request per PMID, which is fine for a typical high-confidence
 * band but means N round-trips / N transactions / N partial-failure modes once a
 * band runs to many hundreds. This loops the SAME upsert + B03 audit over every
 * pmid in ONE MySQL transaction (auth/audit/writeback all reused verbatim), then
 * best-effort mirrors each decision to the engine's DynamoDB after the commit.
 *
 * `revoked` is intentionally NOT a bulk action — undo is always a deliberate
 * single-row gesture, so it stays on the single-claim route.
 *
 * Authorization (403): owner OR curator of THIS core
 * (`UnitAdmin(entityType="core", entityId=coreId)`), or a Superuser — resolved
 * ONCE (the core dimension is identical for every pmid in the batch).
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
import { writeBackCoreClaim } from "@/lib/cores/claim-writeback";

const PATH = "/api/edit/core-claim/bulk";
/** A PMID is a non-empty run of digits, no leading zero (PubMed never mints one). */
const PMID_PATTERN = /^[1-9][0-9]*$/;
/** Cap the batch — generous for any real high-confidence band, but a guard so a
 *  pathological body is a 400, not an unbounded transaction. */
const MAX_BULK_PMIDS = 500;

/** A bulk decision is `claimed` or `rejected` (never `revoked` — see file header). */
function isBulkClaimStatus(value: unknown): value is "claimed" | "rejected" {
  return value === "claimed" || value === "rejected";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  // --- body shape ---
  const { coreId, pmids, status } = body;
  if (typeof coreId !== "string" || coreId.length === 0 || coreId.length > 32) {
    return editError(400, "invalid_core_id", "coreId");
  }
  if (!isBulkClaimStatus(status)) {
    return editError(400, "invalid_status", "status");
  }
  if (!Array.isArray(pmids) || pmids.length === 0 || pmids.length > MAX_BULK_PMIDS) {
    return editError(400, "invalid_pmids", "pmids");
  }
  // De-dupe and validate every PMID up front — reject the whole batch on any bad one.
  const uniquePmids = [...new Set(pmids)];
  if (!uniquePmids.every((p) => typeof p === "string" && PMID_PATTERN.test(p))) {
    return editError(400, "invalid_pmids", "pmids");
  }
  const targetPmids = uniquePmids as string[];

  // --- the core must exist (core_claim is FK-less, so validate explicitly) ---
  const core = await db.read.core.findUnique({ where: { id: coreId }, select: { id: true } });
  if (!core) return editError(404, "core_not_found", "coreId");

  // --- authorization (403): owner/curator of THIS core, or a Superuser. The core
  //     dimension is the same for every pmid, so resolve the role ONCE. ---
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

  // Prior ACTIVE claims for this core, keyed by pmid — drives idempotent skips
  // (a pmid already at the target status needs no re-write) + audit before-values.
  const active = await loadActiveCoreClaimsByCore(coreId, db.read);
  const toWrite = targetPmids.filter((p) => active.get(p) !== status);
  const skipped = targetPmids.length - toWrite.length;

  if (toWrite.length > 0) {
    const now = new Date();
    try {
      await db.write.$transaction(async (tx) => {
        for (const pmid of toWrite) {
          await tx.coreClaim.upsert({
            where: { pmid_coreId: { pmid, coreId } },
            create: { pmid, coreId, status, claimedBy: session.cwid, claimedAt: now, note: null },
            update: {
              status,
              claimedBy: session.cwid,
              claimedAt: now,
              note: null,
              revokedBy: null,
              revokedAt: null,
            },
          });
          const prior = active.get(pmid);
          await appendAuditRow(tx, {
            actorCwid: realCwid,
            impersonatedCwid,
            targetEntityType: "core",
            targetEntityId: `${coreId}:${pmid}`,
            action: "core_claim",
            fieldsChanged: ["status"],
            // Same before-value shape the single route writes (a bulk prior is
            // always an ACTIVE claim — `active` filters revokedAt:null — so revoked:false).
            beforeValues: prior ? { status: prior, revoked: false } : null,
            afterValues: { status },
            ts: now,
            requestId,
          });
        }
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }
  }

  // --- best-effort engine writeback (dormant-safe, non-blocking), AFTER the
  //     commit so it can never fail or slow the claim. One per written pmid. ---
  const writeback = await Promise.allSettled(
    toWrite.map((pmid) =>
      writeBackCoreClaim({ pmid, coreId, status }).catch((err) => {
        logEditFailure(`${PATH}#writeback`, err);
        return { ok: false as const, skipped: false as const };
      }),
    ),
  );
  const writebackOk = writeback.filter(
    (r) => r.status === "fulfilled" && r.value.ok,
  ).length;

  return editOk({
    coreId,
    status,
    written: toWrite.length,
    skipped,
    writebackOk,
  });
}
