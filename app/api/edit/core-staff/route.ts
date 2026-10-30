/**
 * POST/DELETE /api/edit/core-staff: a core owner (or Superuser / comms_steward /
 * core_director, all admitted by `getCoreOwnerRole` + `authorizeCoreClaim`)
 * maintains the core's curated STAFF list in the Staff section of
 * `/edit/core/[coreId]`. The twin of `/api/edit/core-client`, minus its
 * name-only mode: staff exist to be matched by CWID, so a name alone has
 * nothing to feed the engine.
 *
 * POST body: `{ coreId: string; cwids: string[] }`, a pasted block, re-parsed
 * here with `parseCwidBlock` (never trusting the client). Malformed tokens come
 * back as `invalid`, not a rejected batch. Response:
 * `{ added: string[], alreadyPresent: string[], invalid: string[], writeback }`.
 * The panel refreshes the page to show names, so the route resolves none.
 *
 * DELETE body: `{ coreId: string; cwid: string }`. `{ removed: true }`, or 404
 * when the CWID is not on the list.
 *
 * Each write is one MySQL transaction: the `core_staff` row(s) + a B03 audit
 * row each (`core_staff_add` / `core_staff_remove`, `targetEntityType: "core"`,
 * `targetEntityId: "{coreId}:{cwid}"`, before/after `{ active: boolean }`), and
 * a re-read of the FULL staff list inside the same transaction. That in-tx list
 * is what gets mirrored to the engine's DynamoDB after commit
 * (`lib/cores/staff-writeback.ts`, best-effort, never fails the write): a
 * reader-replica read there would race replica lag. The pre-write reads that
 * gate what gets written go through `db.write` for the same reason.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { parseCwidBlock } from "@/lib/cores/cwid-block";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  authorizeCoreClaim,
  getCoreOwnerRole,
  logEditDenial,
  type CoreOwnerLookup,
} from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import type { EditSession } from "@/lib/auth/superuser";
import { writeBackCoreStaff } from "@/lib/cores/staff-writeback";

const PATH = "/api/edit/core-staff";
/** Generous for a real paste; a guard so a pathological body is a 400. */
const MAX_CWIDS = 500;

/** Mirror the core's FULL staff list to the engine, best-effort. Never throws.
 *  `cwids` must come from a read taken INSIDE the write transaction. */
async function mirrorStaff(coreId: string, cwids: string[]): Promise<unknown> {
  return writeBackCoreStaff({ coreId, cwids }).catch((err) => {
    logEditFailure(`${PATH}#writeback`, err);
    return { ok: false as const, skipped: false as const };
  });
}

/** Shared gate: the core exists (404) and the caller owns it (403). Returns a
 *  response to send, or `null` to proceed. */
async function gate(
  session: EditSession,
  realCwid: string,
  coreId: string,
  targetEntityId: string,
): Promise<NextResponse | null> {
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
      targetEntityId,
    });
    return editError(403, authz.reason);
  }
  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

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

  const denied = await gate(session, realCwid, coreId, coreId);
  if (denied) return denied;

  // One array element can carry a whole pasted block, so cap what it parsed
  // out to as well as the array length.
  const { cwids: parsed, invalid } = parseCwidBlock(cwids.join("\n"));
  if (parsed.length > MAX_CWIDS) return editError(400, "invalid_cwids", "cwids");

  const existing =
    parsed.length > 0
      ? await db.write.coreStaff.findMany({
          where: { coreId, cwid: { in: parsed } },
          select: { cwid: true },
        })
      : [];
  const present = new Set(existing.map((r) => r.cwid.toLowerCase()));
  const toWrite = parsed.filter((c) => !present.has(c));
  const alreadyPresent = parsed.filter((c) => present.has(c));

  let writeback: unknown;
  if (toWrite.length > 0) {
    const now = new Date();
    let mirrorCwids: string[];
    try {
      mirrorCwids = await db.write.$transaction(async (tx) => {
        for (const cwid of toWrite) {
          await tx.coreStaff.create({
            data: { coreId, cwid, addedBy: session.cwid, createdAt: now },
          });
          await appendAuditRow(tx, {
            actorCwid: realCwid,
            impersonatedCwid,
            targetEntityType: "core",
            targetEntityId: `${coreId}:${cwid}`,
            action: "core_staff_add",
            fieldsChanged: ["staff"],
            beforeValues: { active: false },
            afterValues: { active: true },
            ts: now,
            requestId,
          });
        }
        const after = await tx.coreStaff.findMany({ where: { coreId }, select: { cwid: true } });
        return after.map((r) => r.cwid);
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }
    writeback = await mirrorStaff(coreId, mirrorCwids);
  }

  return editOk({ added: toWrite, alreadyPresent, invalid, writeback });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  const { coreId, cwid } = body;
  if (typeof coreId !== "string" || coreId.length === 0 || coreId.length > 32) {
    return editError(400, "invalid_core_id", "coreId");
  }
  if (typeof cwid !== "string" || cwid.length === 0) {
    return editError(400, "invalid_cwid", "cwid");
  }
  const { cwids: parsed, invalid } = parseCwidBlock(cwid);
  if (parsed.length !== 1 || invalid.length !== 0) {
    return editError(400, "invalid_cwid", "cwid");
  }
  const target = parsed[0];

  const denied = await gate(session, realCwid, coreId, `${coreId}:${target}`);
  if (denied) return denied;

  const existing = await db.write.coreStaff.findUnique({
    where: { coreId_cwid: { coreId, cwid: target } },
    select: { cwid: true },
  });
  if (!existing) return editError(404, "staff_not_found", "cwid");

  const now = new Date();
  let mirrorCwids: string[];
  try {
    mirrorCwids = await db.write.$transaction(async (tx) => {
      await tx.coreStaff.delete({ where: { coreId_cwid: { coreId, cwid: target } } });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "core",
        targetEntityId: `${coreId}:${target}`,
        action: "core_staff_remove",
        fieldsChanged: ["staff"],
        beforeValues: { active: true },
        afterValues: { active: false },
        ts: now,
        requestId,
      });
      const after = await tx.coreStaff.findMany({ where: { coreId }, select: { cwid: true } });
      return after.map((r) => r.cwid);
    });
  } catch (err) {
    logEditFailure(`${PATH}#remove`, err);
    return editError(500, "write_failed");
  }

  const writeback = await mirrorStaff(coreId, mirrorCwids);
  return editOk({ removed: true, writeback });
}
