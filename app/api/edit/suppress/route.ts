/**
 * POST /api/edit/suppress — insert one `suppression` row (#356,
 * `self-edit-spec.md` § `/api/edit/*`, § Suppression UX and behavior).
 *
 * Body: `{ entityType: "scholar" | "publication", entityId, contributorCwid?, reason }`.
 * A scholar suppression also projects `Scholar.status = 'suppressed'`. The
 * suppression row, the status projection, and the B03 audit row commit in one
 * transaction. A duplicate of an already-active suppression is an idempotent
 * no-op (edge case 19).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { authorizeSuppress, logEditDenial } from "@/lib/edit/authz";
import {
  checkProxyConflictingRole,
  isGrantedProxy,
  type ProxyLookup,
} from "@/lib/edit/proxy-authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import {
  reflectUnitChange,
  reflectVisibilityChange,
  resolveAffectedProfiles,
} from "@/lib/edit/revalidation";
import { reflectSearchSuppression } from "@/lib/edit/search-suppression";
import {
  findSuppressibleEntityOwner,
  findUnit,
  isChairAppointment,
  publicationAuthorshipExists,
} from "@/lib/edit/validators";

const PATH = "/api/edit/suppress";

/** Default `reason` for a self-action that left it blank (`self-edit-spec.md`). */
const SELF_SUPPRESS_REASON = "Self-suppressed via /edit";
const SELF_HIDE_REASON = "Hidden by the author via /edit";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // --- body shape ---
  const { entityType, entityId, contributorCwid, reason } = body;
  // #160 — scholar + publication (PR #356), education + appointment (PR-A),
  // grant (PR-B), mentee (#160 follow-up). #540 Phase 5 — department +
  // division + center (whole-unit retire, Superuser only). A grant row is
  // per-(award, investigator), so suppressing it hides that one investigator's
  // role; a funding project goes dark only when all its rows are suppressed. A
  // mentee suppression hides one derived mentor↔mentee relationship from the
  // mentor's profile.
  if (
    entityType !== "scholar" &&
    entityType !== "publication" &&
    entityType !== "education" &&
    entityType !== "appointment" &&
    entityType !== "grant" &&
    entityType !== "mentee" &&
    entityType !== "department" &&
    entityType !== "division" &&
    entityType !== "center"
  ) {
    return editError(400, "invalid_entity_type", "entityType");
  }
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }
  let contributor: string | null = null;
  if (contributorCwid !== undefined && contributorCwid !== null) {
    if (typeof contributorCwid !== "string" || contributorCwid.length === 0) {
      return editError(400, "invalid_contributor", "contributorCwid");
    }
    contributor = contributorCwid;
  }
  // Only a publication suppression carries a contributor. Scholar, the
  // whole-entity types (education / appointment / grant), and a unit retire
  // (#540) are always whole-entity.
  if (entityType !== "publication" && contributor !== null) {
    return editError(400, "invalid_contributor", "contributorCwid");
  }
  // Set when a scholar-assigned proxy (#779) authorizes a per-author hide on
  // behalf of the granted scholar — drives default-reason parity with a
  // self-author-hide below (a proxy acts with exactly the scholar's surface, D4).
  let viaProxy = false;

  // #540 Phase 5 — unit retire: existence + Superuser gate, then fall into
  // the shared write path below. SPEC § Authorization — unit retire is
  // structural, Superuser only; SPEC § Write-path behavior — the page 404s
  // (via `lib/url-resolver.ts`'s suppression lookup) and the facet drops on
  // the next nightly rebuild; soft and revocable; members untouched.
  const isUnit =
    entityType === "department" ||
    entityType === "division" ||
    entityType === "center";
  let unitForReflection: {
    kind: "department" | "division" | "center";
    slug: string;
    parentDeptSlug?: string;
  } | null = null;
  if (isUnit) {
    const unit = await findUnit(entityType, entityId, db.read);
    if (!unit.ok) return editError(400, "unit_not_found", "entityId");
    if (!session.isSuperuser) {
      logEditDenial({
        actorCwid: session.cwid,
        targetCwid: entityId,
        path: PATH,
        reason: "not_superuser",
        targetEntityType: entityType,
        targetEntityId: entityId,
      });
      return editError(403, "not_superuser");
    }
    unitForReflection = {
      kind: unit.kind,
      slug: unit.slug,
      parentDeptSlug:
        unit.kind === "division" ? (unit.parentDeptSlug ?? undefined) : undefined,
    };
  }

  // --- whole-entity types (#160): resolve the owning scholar by stable
  //     externalId. This is both the 400 existence gate and the source of the
  //     pure-authz owner check. For an appointment, refuse to hide a current
  //     chair role (409, D-leader) so the profile can't contradict the
  //     column-driven dept-page leader card. For a mentee, the owner is the
  //     mentor segment of `{mentorCwid}:{menteeCwid}` — resolved with no DB
  //     lookup (mentees are derived). ---
  const isWholeEntity =
    entityType === "education" ||
    entityType === "appointment" ||
    entityType === "grant" ||
    entityType === "mentee";
  let ownerCwid: string | null = null;
  if (isWholeEntity) {
    const owner = await findSuppressibleEntityOwner(entityType, entityId, db.read);
    if (!owner) return editError(400, "entity_not_found", "entityId");
    ownerCwid = owner.ownerCwid;
    if (
      entityType === "appointment" &&
      owner.title !== null &&
      (await isChairAppointment(owner.ownerCwid, owner.title, db.read))
    ) {
      return editError(409, "leadership_appointment_not_suppressible", "entityId");
    }
  }

  // --- authorization (403) — unit retire bypasses authorizeSuppress (its
  //     contract covers scholar / publication / grant / education /
  //     appointment); the Superuser gate above (`isUnit` branch) is the
  //     unit-specific authz. ---
  if (!isUnit) {
    let authz = authorizeSuppress(session, {
      entityType,
      entityId,
      contributorCwid: contributor,
      ownerCwid,
    });
    // Scholar-assigned proxy editor (#779 / scholar-proxy-spec.md). A granted
    // proxy may hide ONLY the granted scholar's OWN authorship — `publication`
    // AND `contributorCwid === the granted scholar` (a positive allowlist:
    // never another author's authorship, never a whole-publication takedown,
    // never a scholar/grant/education/appointment/mentee suppression —
    // PE-03/IS-2). Keyed on `realCwid`, never while impersonating (PE-01/IS-1);
    // D3 conflict re-check runs fail-closed (PE-02).
    if (
      !authz.ok &&
      entityType === "publication" &&
      contributor !== null &&
      impersonatedCwid === null
    ) {
      if (await isGrantedProxy(realCwid, contributor, db.read as unknown as ProxyLookup)) {
        const conflict = await checkProxyConflictingRole(
          realCwid,
          db.read as unknown as ProxyLookup,
        );
        if (conflict.ok) {
          authz = { ok: true };
          viaProxy = true;
        } else {
          logEditDenial({
            actorCwid: realCwid,
            targetCwid: contributor,
            path: PATH,
            reason: "proxy_conflict",
          });
          return editError(403, "proxy_conflict");
        }
      }
    }
    if (!authz.ok) {
      logEditDenial({
        actorCwid: session.cwid,
        targetCwid:
          entityType === "scholar" ? entityId : (contributor ?? ownerCwid ?? entityId),
        path: PATH,
        reason: authz.reason,
      });
      return editError(403, authz.reason);
    }
  }

  // --- per-author publication hide: the authorship must exist (400, edge 18) ---
  if (entityType === "publication" && contributor !== null) {
    const exists = await publicationAuthorshipExists(entityId, contributor, db.read);
    if (!exists) return editError(400, "no_authorship", "contributorCwid");
  }

  // --- reason: optional for a self-action (defaulted), mandatory otherwise ---
  const isSelfScholar = entityType === "scholar" && session.cwid === entityId;
  const isSelfEntity = isWholeEntity && ownerCwid !== null && session.cwid === ownerCwid;
  const isSelfAuthorHide =
    entityType === "publication" && contributor !== null && session.cwid === contributor;
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  let reasonValue: string;
  if (trimmedReason.length > 0) {
    reasonValue = trimmedReason;
  } else if (isSelfScholar || isSelfEntity) {
    reasonValue = SELF_SUPPRESS_REASON;
  } else if (isSelfAuthorHide || viaProxy) {
    reasonValue = SELF_HIDE_REASON;
  } else {
    // A superuser suppression's reason is mandatory (self-edit-spec.md;
    // unit retire too — SPEC § Authorization is silent on it but the
    // shared write path keeps the surface uniform).
    return editError(400, "reason_required", "reason");
  }

  // --- idempotency (edge 19): an un-revoked matching suppression already exists ---
  const existing = await db.read.suppression.findFirst({
    where: { entityType, entityId, contributorCwid: contributor, revokedAt: null },
    select: { id: true },
  });
  if (existing) return editOk({ suppressionId: existing.id });

  // --- write: suppression + status projection + B03 audit row, one transaction ---
  let suppressionId: string;
  try {
    suppressionId = await db.write.$transaction(async (tx) => {
      const created = await tx.suppression.create({
        data: {
          entityType,
          entityId,
          contributorCwid: contributor,
          reason: reasonValue,
          createdBy: session.cwid,
        },
        select: { id: true },
      });
      if (entityType === "scholar") {
        // Denormalized projection of the suppression table (ADR-005).
        // updateMany — a suppression row may legitimately outlive its target.
        await tx.scholar.updateMany({
          where: { cwid: entityId },
          data: { status: "suppressed" },
        });
      }
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: entityType,
        targetEntityId: entityId,
        action: "suppression_create",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: {
          suppression_id: created.id,
          contributor_cwid: contributor,
          reason: reasonValue,
        },
        ts: new Date(),
        requestId,
      });
      return created.id;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // --- post-commit ---
  if (isSelfScholar) {
    // A scholar hiding their own profile is a care / follow-up signal.
    console.warn(
      JSON.stringify({
        event: "self_suppression",
        scholar_cwid: entityId,
        reason: reasonValue,
        ts: new Date().toISOString(),
        request_id: requestId,
      }),
    );
  }
  // #540 — unit retire: revalidate the unit page (which now 404s via the
  // suppression lookup in `lib/url-resolver.ts`) + `/browse`. The search
  // facet drops on the next nightly rebuild — SPEC § Write-path behavior
  // explicitly disowns the fast-path / reconciler urgency split for units.
  if (unitForReflection) {
    reflectUnitChange({
      unitKind: unitForReflection.kind,
      unitSlug: unitForReflection.slug,
      parentDeptSlug: unitForReflection.parentDeptSlug,
    });
    return editOk({ suppressionId });
  }
  const affected = await resolveAffectedProfiles(entityType, entityId, contributor);
  await reflectVisibilityChange(affected.map((a) => a.slug));
  // Phase 4b C6 — OpenSearch fast-path (lib/edit/search-suppression.ts).
  // Best-effort: failures are logged inside the reflector and never thrown,
  // so they cannot roll back the already-committed write. `affectedCwids` is
  // the cwid half of the same `resolveAffectedProfiles` query — one upstream
  // Prisma read feeds both reflections (plan §3 tightening C7).
  // The result is ignored here (best-effort); on success the reflector stamps
  // `searchReflectedAt`, on failure it leaves it NULL for the #393 reconciler.
  await reflectSearchSuppression({
    suppressionId,
    entityType,
    entityId,
    contributorCwid: contributor,
    affectedCwids: affected.map((a) => a.cwid),
  });

  return editOk({ suppressionId });
}
