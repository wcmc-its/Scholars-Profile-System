/**
 * POST /api/edit/core-claim — a core owner (or a genuine Superuser) claims or
 * rejects a (publication, core) usage candidate.
 *
 * Body: `{ pmid, coreId, status: "claimed" | "rejected", note? }`.
 *
 * The write is one MySQL transaction: upsert the `core_claim` override row (the
 * ADR-005 manual-override layer — it survives the nightly `publication_core`
 * rebuild by construction) + a B03 audit row (`action: "core_claim"`). After the
 * commit it best-effort mirrors the decision to the engine's DynamoDB so the next
 * cores run reads it as a repeat-user prior (dormant-safe; never fails the claim).
 *
 * Authorization (403): owner OR curator of THIS core
 * (`UnitAdmin(entityType="core", entityId=coreId)`), or a Superuser. The grant of
 * that role is a separate Superuser action (`unit_admin` row); until the admin
 * write-UI ships it is provisioned by direct row insert.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  authorizeCoreClaim,
  getCoreOwnerRole,
  logEditDenial,
  type CoreOwnerLookup,
} from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { writeBackCoreClaim } from "@/lib/cores/claim-writeback";

const PATH = "/api/edit/core-claim";
/** A PMID is a non-empty run of digits, no leading zero (PubMed never mints one). */
const PMID_PATTERN = /^[1-9][0-9]*$/;

function isClaimStatus(value: unknown): value is "claimed" | "rejected" {
  return value === "claimed" || value === "rejected";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  // --- body shape ---
  const { pmid, coreId, status, note } = body;
  if (typeof pmid !== "string" || !PMID_PATTERN.test(pmid)) {
    return editError(400, "invalid_pmid", "pmid");
  }
  if (typeof coreId !== "string" || coreId.length === 0 || coreId.length > 32) {
    return editError(400, "invalid_core_id", "coreId");
  }
  if (!isClaimStatus(status)) {
    return editError(400, "invalid_status", "status");
  }
  const noteValue =
    typeof note === "string" && note.trim().length > 0 ? note.trim().slice(0, 2000) : null;

  // --- the core must exist (core_claim is FK-less, so validate explicitly) ---
  const core = await db.read.core.findUnique({ where: { id: coreId }, select: { id: true } });
  if (!core) return editError(404, "core_not_found", "coreId");

  // --- authorization (403): owner/curator of THIS core, or a Superuser ---
  const coreRole = await getCoreOwnerRole(
    session,
    coreId,
    db.read as unknown as CoreOwnerLookup,
  );
  const authz = authorizeCoreClaim(session, coreRole);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: coreId, // the core under review — a claim has no scholar dimension
      path: PATH,
      reason: authz.reason,
      targetEntityId: `${coreId}:${pmid}`,
    });
    return editError(403, authz.reason);
  }

  // --- idempotency: the same ACTIVE decision already exists → ok, no re-write ---
  const existing = await db.read.coreClaim.findUnique({
    where: { pmid_coreId: { pmid, coreId } },
    select: { status: true, revokedAt: true, note: true },
  });
  if (
    existing &&
    existing.revokedAt === null &&
    existing.status === status &&
    existing.note === noteValue
  ) {
    return editOk({ pmid, coreId, status, unchanged: true });
  }

  // --- write: upsert core_claim (clearing any prior soft-revoke) + B03 audit, one tx ---
  const now = new Date();
  try {
    await db.write.$transaction(async (tx) => {
      await tx.coreClaim.upsert({
        where: { pmid_coreId: { pmid, coreId } },
        create: { pmid, coreId, status, claimedBy: session.cwid, claimedAt: now, note: noteValue },
        update: {
          status,
          claimedBy: session.cwid,
          claimedAt: now,
          note: noteValue,
          revokedBy: null,
          revokedAt: null,
        },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "core",
        targetEntityId: `${coreId}:${pmid}`,
        action: "core_claim",
        fieldsChanged: ["status"],
        beforeValues: existing
          ? { status: existing.status, revoked: existing.revokedAt !== null }
          : null,
        afterValues: { status, note: noteValue },
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // --- best-effort engine writeback (dormant-safe, non-blocking): mirror the
  //     decision to DynamoDB so the next cores run sees it as a repeat-user prior.
  //     A failure (or unconfigured writeback) never fails the claim. ---
  const writeback = await writeBackCoreClaim({ pmid, coreId, status }).catch((err) => {
    logEditFailure(`${PATH}#writeback`, err);
    return { ok: false as const, skipped: false as const };
  });

  return editOk({ pmid, coreId, status, writeback });
}
