/**
 * POST /api/edit/orcid — set a scholar's ORCID iD from the Identifiers & Profiles
 * tab: confirm the inferred suggestion, or enter one.
 *
 * Body: `{ cwid: string, orcid: string | null, confirmedSuggestion?: boolean }`.
 * `orcid: null` REMOVES the iD: the `admin_orcid` row is deleted, `scholar.orcid`
 * is nulled, and the local `rpm_admin` mirror row goes with it (else the card
 * would keep reading the iD as on file until the 07:00 UTC re-mirror).
 *
 * Two writes, in this order, and the order is the point:
 *  1. ReciterDB `admin_orcid` (the table Publication Manager's Manage Profile
 *     writes). The nightly `etl/orcid-candidates` mirror grades it asserted, and it
 *     is the source the Institutional Client is asked to merge into DynamoDB
 *     `Identity.orcid` (IC #155, open at the time of writing) so ReCiter's ORCID
 *     retrieval can fire. If ReciterDB is unreachable (the SPS VPC → WCM path can
 *     be down) the request fails with 502 and NOTHING has changed — an iD on file
 *     here but unknown to ReCiter is the one state this route must never produce.
 *  2. `scholar.orcid` + the B03 audit row, one transaction. This makes the row,
 *     the biosketch worksheet, and the dashboard flip immediately instead of
 *     after the 07:00 UTC mirror. If this step fails after (1) succeeded, the
 *     mirror's `rpm_admin` row shows the iD as on file from tomorrow (the flag
 *     that admits this route is the same one that folds that row in), and a
 *     retry is idempotent.
 *
 * Gated by `SELF_EDIT_ORCID_SUGGESTION` (404 when off) — the kill switch for the
 * first SPS → ReciterDB write.
 *
 * Authorization rides `authorizeOverviewWrite`, keyed on the target `cwid`:
 * self OR superuser OR comms_steward OR granted proxy (#779) OR org-unit
 * owner/curator (#728) — the same set that may edit the bio. The iD is
 * normalized and checksummed (`normalizeOrcid`); a typo is a 400, never a
 * wrong iD on file.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isCwid } from "@/lib/cwid";
import { normalizeOrcid } from "@/lib/edit/orcid";
import { isOrcidSuggestionEnabled } from "@/lib/edit/orcid-suggestion-flag";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectOverviewEdit } from "@/lib/edit/revalidation";
import { type UnitScholarLookup } from "@/lib/edit/unit-scholar-authz";
import { withReciterConnection } from "@/lib/sources/reciterdb";

const PATH = "/api/edit/orcid";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isOrcidSuggestionEnabled()) return editError(404, "not_found");
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // --- body shape ---
  const { cwid, orcid: rawOrcid, confirmedSuggestion } = body;
  if (typeof cwid !== "string" || !isCwid(cwid)) return editError(400, "invalid_cwid", "cwid");
  if (rawOrcid !== null && typeof rawOrcid !== "string") {
    return editError(400, "invalid_orcid", "orcid");
  }
  const orcid = rawOrcid === null ? null : normalizeOrcid(rawOrcid);
  if (rawOrcid !== null && !orcid) return editError(400, "invalid_orcid", "orcid");

  // --- target scholar (404) ---
  const scholar = await db.read.scholar.findUnique({
    where: { cwid },
    select: { cwid: true, slug: true, orcid: true },
  });
  if (!scholar) return editError(404, "scholar_not_found", "cwid");

  // --- authorization (403) ---
  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId: scholar.cwid,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: scholar.cwid, path: PATH, reason: authz.reason });
    return editError(403, authz.reason);
  }

  // --- (1) ReciterDB admin_orcid — fail closed, nothing else has changed ---
  try {
    await withReciterConnection(async (conn) => {
      if (orcid === null) {
        await conn.query("DELETE FROM admin_orcid WHERE personIdentifier = ?", [scholar.cwid]);
      } else {
        await conn.query(
          "INSERT INTO admin_orcid (personIdentifier, orcid) VALUES (?, ?) ON DUPLICATE KEY UPDATE orcid = VALUES(orcid)",
          [scholar.cwid, orcid],
        );
      }
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(502, "reciter_unavailable");
  }

  // --- (2) scholar.orcid + the B03 audit row, one transaction ---
  try {
    await db.write.$transaction(async (tx) => {
      await tx.scholar.update({ where: { cwid: scholar.cwid }, data: { orcid } });
      // The iD being removed is usually NOT on `scholar.orcid` (NULL for WCM —
      // the card reads it from the `rpm_admin` mirror row), so read it before
      // the row goes, or the audit row would say null → null.
      let before = scholar.orcid;
      if (orcid === null) {
        const admin = await tx.orcidCandidate.findFirst({
          where: { cwid: scholar.cwid, source: "rpm_admin" },
          select: { orcid: true },
        });
        before ??= admin?.orcid ?? null;
        await tx.orcidCandidate.deleteMany({ where: { cwid: scholar.cwid, source: "rpm_admin" } });
      }
      // ponytail: a remove audits as `orcid_set` → null (+ `removed: true`)
      // rather than a new action — a new AuditAction needs the TS union AND
      // four SQL ENUM sites.
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "scholar",
        targetEntityId: scholar.cwid,
        action: "orcid_set",
        fieldsChanged: ["orcid"],
        beforeValues: { orcid: before },
        afterValues: {
          orcid,
          ...(orcid === null ? { removed: true } : {}),
          ...(confirmedSuggestion === true ? { confirmed_suggestion: true } : {}),
          ...(authz.viaUnitAdminUnit
            ? {
                edited_via: "unit_admin",
                via_unit_type: authz.viaUnitAdminUnit.kind,
                via_unit_code: authz.viaUnitAdminUnit.code,
              }
            : {}),
        },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // --- post-commit: the public profile shows the iD ---
  await reflectOverviewEdit(scholar.slug);

  return editOk({ orcid });
}
