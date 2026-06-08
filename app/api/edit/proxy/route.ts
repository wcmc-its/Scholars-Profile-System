/**
 * POST /api/edit/proxy — assign / revoke a scholar-assigned proxy editor
 * (#779 / scholar-proxy-spec.md § API and UI). Mirrors `app/api/edit/grant`
 * (the unit_admin grant/revoke), but writes the per-scholar `scholar_proxy`
 * grant table and keys EVERYTHING on the real human (`realCwid`), never the
 * effective/impersonated identity.
 *
 * Body: `{ scholarCwid, proxyCwid, action: "grant" | "revoke" }`.
 *
 * Authorization (D1): only the real scholar themselves, OR a real superuser on
 * the scholar's behalf. A proxy can NEVER grant/revoke — including for the
 * scholar they serve (CD-2). Routed through `readEditRequest` for the
 * same-origin + Content-Type CSRF guard (CD-4) — never hand-rolled.
 *
 * A grant is BLOCKED while impersonating (IS-10/CD-1): a superuser-on-behalf
 * grant must be a recorded superuser action with `grantedBy = realCwid`, not
 * laundered as a scholar self-assignment under a "View as" overlay.
 *
 * D3 "no other role" runs BLOCKING at grant time — all three legs incl. the live
 * `isSuperuser` (CD-3); the distinct failure reason stays server-side while the
 * HTTP body is an opaque `proxy_ineligible` so the endpoint is not a role-oracle
 * (CD-6). The row is inserted on grant and HARD-DELETED on revoke, each in one
 * transaction with a B03 audit row (`proxy_grant` / `proxy_revoke`). After a
 * grant commits, both parties are notified best-effort (D2; dormant by flag).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { checkProxyConflictingRole, type ProxyLookup } from "@/lib/edit/proxy-authz";
import { notifyProxyGrant } from "@/lib/edit/proxy-notification";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { CWID_PATTERN, isGrantAction } from "@/lib/edit/validators";

const PATH = "/api/edit/proxy";

/** Server-backed per-scholar cap behind any UI soft-limit (D5/PE-08). The model
 *  enforces none; this bounds a compromised scholar account's blast radius. */
const MAX_PROXIES_PER_SCHOLAR = 10;

/** Normalize to canonical lowercase, then validate (PE-04): `BEC4010 ` ⇒ `bec4010`.
 *  Returns null for a non-string or a value that fails the CWID grammar. */
function normCwid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const c = value.trim().toLowerCase();
  return CWID_PATTERN.test(c) ? c : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // 1. Normalize + validate BEFORE any role check (PE-04).
  const scholarCwid = normCwid(body.scholarCwid);
  const proxyCwid = normCwid(body.proxyCwid);
  const { action } = body;
  if (!scholarCwid) return editError(400, "invalid_cwid", "scholarCwid");
  if (!proxyCwid) return editError(400, "invalid_cwid", "proxyCwid");
  if (typeof action !== "string" || !isGrantAction(action)) {
    return editError(400, "invalid_action", "action");
  }

  // 2. A proxy grant/revoke is NEVER an impersonated action (IS-10/CD-1): block
  //    while a "View as" overlay is live so a superuser-on-behalf grant is
  //    recorded as a real superuser action (grantedBy = realCwid), not laundered
  //    as scholar-self under the overlay.
  if (impersonatedCwid !== null) return editError(403, "impersonation_block");

  // 3. Self-proxy is a confusing no-op (a scholar edits directly).
  if (scholarCwid === proxyCwid) return editError(400, "cannot_proxy_self", "proxyCwid");

  // 4. Authz (D1): the real scholar themselves, OR a real superuser. Not
  //    impersonating ⇒ realCwid === session.cwid and session.isSuperuser is the
  //    real verdict. A proxy can NEVER manage the proxy list (CD-2).
  const allowed = realCwid === scholarCwid || session.isSuperuser;
  if (!allowed) {
    logEditDenial({ actorCwid: realCwid, targetCwid: scholarCwid, path: PATH, reason: "not_self" });
    return editError(403, "not_self");
  }

  // 5. The scholar must exist and be live — a proxy can only serve a live
  //    scholar. Also yields name/email for the notification.
  const scholar = await db.read.scholar.findUnique({
    where: { cwid: scholarCwid },
    select: { deletedAt: true, preferredName: true, email: true },
  });
  if (!scholar || scholar.deletedAt !== null) {
    return editError(400, "scholar_not_found", "scholarCwid");
  }

  // Idempotency probe — the current grant row, if any.
  const existing = await db.read.scholarProxy.findUnique({
    where: { scholarCwid_proxyCwid: { scholarCwid, proxyCwid } },
    select: { grantedBy: true },
  });

  if (action === "revoke") {
    // Revoking a non-existent grant is an idempotent no-op (no audit row).
    if (!existing) {
      return editOk({ scholarCwid, proxyCwid, action: "revoke", changed: false });
    }
    try {
      await db.write.$transaction(async (tx) => {
        await tx.scholarProxy.delete({
          where: { scholarCwid_proxyCwid: { scholarCwid, proxyCwid } },
        });
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid: null, // a grant is never impersonated (blocked above)
          targetEntityType: "scholar",
          targetEntityId: scholarCwid,
          action: "proxy_revoke",
          fieldsChanged: null,
          beforeValues: { proxy_cwid: proxyCwid, granted_by: existing.grantedBy },
          afterValues: null,
          ts: new Date(),
          requestId,
        });
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }
    return editOk({ scholarCwid, proxyCwid, action: "revoke", changed: true });
  }

  // action === "grant"
  // 6. D3 "no other role" — BLOCKING, all three legs incl. live isSuperuser
  //    (CD-3). Keep the specific reason server-side; HTTP body is opaque (CD-6).
  const conflict = await checkProxyConflictingRole(proxyCwid, db.read as unknown as ProxyLookup);
  if (!conflict.ok) {
    logEditDenial({ actorCwid: realCwid, targetCwid: scholarCwid, path: PATH, reason: conflict.reason });
    return editError(403, "proxy_ineligible");
  }

  // 7. Cardinality cap (D5/PE-08) — only when adding a NEW pair.
  if (!existing) {
    const count = await db.read.scholarProxy.count({ where: { scholarCwid } });
    if (count >= MAX_PROXIES_PER_SCHOLAR) return editError(400, "proxy_limit_reached");
  }

  // 8. Write — upsert + B03 audit row, one transaction. grantedBy = realCwid
  //    (CD-1/IS-10), never session.cwid.
  try {
    await db.write.$transaction(async (tx) => {
      await tx.scholarProxy.upsert({
        where: { scholarCwid_proxyCwid: { scholarCwid, proxyCwid } },
        create: { scholarCwid, proxyCwid, grantedBy: realCwid },
        update: { grantedBy: realCwid },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid: null,
        targetEntityType: "scholar",
        targetEntityId: scholarCwid,
        action: "proxy_grant",
        fieldsChanged: null,
        beforeValues: existing ? { proxy_cwid: proxyCwid, granted_by: existing.grantedBy } : null,
        afterValues: { proxy_cwid: proxyCwid, granted_by: realCwid },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // 9. After commit — best-effort notification (D2), dormant unless configured.
  await notifyProxyGrant({
    proxyCwid,
    scholarCwid,
    scholarName: scholar.preferredName,
    scholarEmail: scholar.email,
    byScholarSelf: realCwid === scholarCwid,
    grantorCwid: realCwid,
  });

  return editOk({ scholarCwid, proxyCwid, action: "grant", changed: true });
}
