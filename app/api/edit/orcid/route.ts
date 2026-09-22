/**
 * POST /api/edit/orcid — set a scholar's ORCID iD from the Identifiers & Profiles
 * tab: confirm the inferred suggestion, or enter one.
 *
 * Body: `{ cwid: string, orcid: string | null, confirmedSuggestion?: boolean }`.
 *
 * SPS is the durable record; one `db.write` transaction, nothing outside SPS.
 * `etl:orcid-push` (nightly, before `etl:identity`) copies the result into WCM
 * Identity, which ReCiter and Publication Manager read. ReciterDB `admin_orcid`
 * is NOT written: RPM stopped writing it 2026-04-05 and nothing reads it back
 * into Identity.
 *  - Set / confirm (`orcid` non-null): `scholar.orcid` = the iD,
 *    `orcid_confirmed_at` = now, and any `orcid_dismissal` for exactly this
 *    (cwid, iD) is deleted — the person re-confirming an iD they once removed.
 *  - Remove (`orcid: null`): `scholar.orcid` and `orcid_confirmed_at` are
 *    nulled and the removed iD gets an `orcid_dismissal` row. The dismissal is
 *    what makes `etl:orcid-push` clear it from Identity, `etl:identity` not
 *    re-import it, and the `orcid_candidate` readers (`withoutDismissed`) drop
 *    the `rpm_admin` row the nightly mirror re-creates from the dead-but-still-
 *    populated `admin_orcid`. The local `rpm_admin` row is also deleted here so
 *    the card flips now, not after the 07:00 UTC re-mirror.
 *  Plus the B03 audit row, same transaction.
 *
 * Gated by `SELF_EDIT_ORCID_SUGGESTION` (404 when off) — one kill switch for the
 * tab, this write, and the suggestion.
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

  // --- scholar.orcid + dismissal + the B03 audit row, one transaction ---
  try {
    await db.write.$transaction(async (tx) => {
      await tx.scholar.update({
        where: { cwid: scholar.cwid },
        data: { orcid, orcidConfirmedAt: orcid === null ? null : new Date() },
      });
      // The iD being removed is usually NOT on `scholar.orcid` (NULL for WCM —
      // the card reads it from the `rpm_admin` mirror row), so read it before
      // the row goes, or the audit row would say null → null and nothing
      // would be dismissed.
      let before = scholar.orcid;
      if (orcid === null) {
        const admin = await tx.orcidCandidate.findFirst({
          where: { cwid: scholar.cwid, source: "rpm_admin" },
          select: { orcid: true },
        });
        before ??= admin?.orcid ?? null;
        await tx.orcidCandidate.deleteMany({ where: { cwid: scholar.cwid, source: "rpm_admin" } });
        if (before !== null) {
          await tx.orcidDismissal.upsert({
            where: { cwid_orcid: { cwid: scholar.cwid, orcid: before } },
            create: { cwid: scholar.cwid, orcid: before },
            update: {},
          });
        }
      } else {
        await tx.orcidDismissal.deleteMany({ where: { cwid: scholar.cwid, orcid } });
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
