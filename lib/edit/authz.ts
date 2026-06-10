/**
 * Self-edit v1 — the per-action authorization predicate (#356,
 * `self-edit-spec.md` § Authorization).
 *
 * B01 supplies the identity session; B02 (`lib/auth/superuser.ts`) supplies the
 * live `isSuperuser` verdict, paired as `EditSession` `{ cwid, isSuperuser }`.
 * This module is the *rules*: given an `EditSession` and a described action,
 * may it proceed? Every predicate here is **pure and synchronous** — the only
 * DB-backed gate, "is this CWID a confirmed author of this pmid", is a `400`
 * validation (`publicationAuthorshipExists`, `lib/edit/validators.ts`), not a
 * `403`, and lives there.
 *
 * `isSuperuser` must be re-evaluated on every `/edit/*` GET and every
 * `/api/edit*` POST (never cached for the session) — that is the caller's
 * responsibility via `getEditSession()`; this module consumes the result.
 *
 * A denied request emits one `edit_authz_denied` line via `logEditDenial()`,
 * which wraps B02's `logAuthzDenied()`.
 */
import { logAuthzDenied } from "@/lib/auth/authz-events";
import type { EditSession } from "@/lib/auth/superuser";

/** Stable denial reasons — the `reason` field of an `edit_authz_denied` event. */
export type AuthzDenialReason =
  /** a self-only action attempted against another CWID */
  | "not_self"
  /** a superuser-only action by a non-superuser */
  | "not_superuser"
  /** a revoke of a suppression the actor did not create */
  | "not_owner"
  // ─── #540 / ADR-005 Amendment 1 § A1.2 unit-curation denials ───
  /** a unit-edit POST by an actor with neither Owner nor Curator on the unit */
  | "not_curator"
  /** a `unit_admin` grant/revoke POST by an actor with no Owner role on the unit */
  | "not_unit_owner"
  /** `canGrant`: the target unit is outside the actor's owned subtree */
  | "scope_violation"
  /** `canGrant`: the actor's role is below the role they are trying to grant */
  | "authority_violation"
  // ─── scholar-assigned proxy editor (#779 / scholar-proxy-spec.md) ───
  /** a scholar-assigned proxy edit by a CWID that has since acquired a
   *  conflicting role (the D3 fail-closed re-check at edit time — Amendment 4 D4
   *  narrows that to "is a superuser") */
  | "proxy_conflict"
  // ─── #728 § 2.2 #3 / § 5 MUST-7 ED-locked grant ───
  /** a grant/revoke against a `unit_admin` row whose `source` LIKE 'ED:%' by a non-superuser */
  | "ed_locked";

export type AuthzResult = { ok: true } | { ok: false; reason: AuthzDenialReason };

const ALLOW: AuthzResult = { ok: true };

// ---------------------------------------------------------------------------
// per-action predicates  (self-edit-spec.md § Authorization, the rules table)
// ---------------------------------------------------------------------------

/**
 * `POST /api/edit/field`. `overview` and `selectedHighlightPmids` (#836) are
 * **self only** — a superuser does not inherit them (broad admin field-editing
 * is deferred). `slug` is superuser-only.
 */
export function authorizeFieldEdit(
  session: EditSession,
  target: { entityId: string; fieldName: "overview" | "slug" | "selectedHighlightPmids" },
): AuthzResult {
  if (target.fieldName === "overview" || target.fieldName === "selectedHighlightPmids") {
    return session.cwid === target.entityId ? ALLOW : { ok: false, reason: "not_self" };
  }
  return session.isSuperuser ? ALLOW : { ok: false, reason: "not_superuser" };
}

/**
 * `POST /api/edit/suppress`:
 *   - scholar, whole-entity                    → the scholar themselves, or a superuser
 *   - grant / education / appointment / mentee → the owning scholar, or a superuser (#160)
 *   - publication, per-author                  → the actor suppressing *themselves* as a
 *                                                contributor, or a superuser
 *   - publication, whole-entity                → superuser only (retraction / takedown)
 *
 * Scholar and grant/education/appointment/mentee suppressions never carry a
 * `contributorCwid`. For the whole-entity types the owning scholar's cwid
 * (`ownerCwid`) is resolved upstream (`findSuppressibleEntityOwner`) and passed
 * in so this predicate stays pure (the mentee owner = the mentor segment of the
 * `{mentorCwid}:{menteeCwid}` externalId). The per-author authorship-existence
 * check and the whole-entity existence check are separate `400` validations,
 * not part of this `403` predicate.
 */
export function authorizeSuppress(
  session: EditSession,
  target: {
    entityType: "scholar" | "publication" | "grant" | "education" | "appointment" | "mentee";
    entityId: string;
    contributorCwid?: string | null;
    /** Owner cwid of a whole-entity grant/education/appointment/mentee target. */
    ownerCwid?: string | null;
  },
): AuthzResult {
  if (session.isSuperuser) return ALLOW;

  if (target.entityType === "scholar") {
    return session.cwid === target.entityId ? ALLOW : { ok: false, reason: "not_self" };
  }

  if (
    target.entityType === "grant" ||
    target.entityType === "education" ||
    target.entityType === "appointment" ||
    target.entityType === "mentee"
  ) {
    // Whole-entity self-suppression: a scholar may hide only their own
    // grant / education / appointment, or (mentee) a mentee on THEIR OWN
    // profile — for a mentee the owner is the mentor, resolved upstream from
    // the `{mentorCwid}:{menteeCwid}` externalId (#160).
    return session.cwid === (target.ownerCwid ?? null)
      ? ALLOW
      : { ok: false, reason: "not_self" };
  }

  // publication
  const contributor = target.contributorCwid ?? null;
  if (contributor === null) {
    // whole-publication takedown — superuser only (handled above)
    return { ok: false, reason: "not_superuser" };
  }
  // per-author hide — a scholar may suppress only themselves as a contributor
  return session.cwid === contributor ? ALLOW : { ok: false, reason: "not_self" };
}

/**
 * `POST /api/edit/revoke`. A scholar may lift only a suppression they applied
 * themselves (`created_by == session.cwid`); a superuser may lift any.
 */
export function authorizeRevoke(
  session: EditSession,
  suppression: { createdBy: string },
): AuthzResult {
  if (session.isSuperuser) return ALLOW;
  return session.cwid === suppression.createdBy
    ? ALLOW
    : { ok: false, reason: "not_owner" };
}

// ---------------------------------------------------------------------------
// page-access predicates  (the GET-time superuser re-check)
// ---------------------------------------------------------------------------

/**
 * `GET /edit/scholar/[cwid]`: the scholar themselves (renders exactly `/edit`)
 * or a superuser. The superuser GET pages read with the suppression filter OFF,
 * so this re-check on the page load — not only on the POST — closes the data-
 * exposure window when a user loses `scholars-admins` mid-session (edge 15).
 */
export function canAccessScholarEditPage(
  session: EditSession,
  targetCwid: string,
): boolean {
  return session.cwid === targetCwid || session.isSuperuser;
}

/** `GET /edit/publication/[pmid]`: superuser only. */
export function canAccessPublicationEditPage(session: EditSession): boolean {
  return session.isSuperuser;
}

/**
 * Phase 7 § 11 — the GET-time superuser re-check used by
 * `/edit/scholar/[cwid]` (when `cwid != session.cwid`) and
 * `/edit/publication/[pmid]`. Returns `null` on allow, or `"not_superuser"`
 * after emitting one structured `edit_authz_denied` line. Centralises the
 * denial-log shape so the two routes cannot drift; the page handler responds
 * with the visible 403 page when this returns non-null (Phase 7 D7.2). The
 * `not_superuser_get` reason distinguishes a page-GET denial from the
 * `/api/edit/*` POST `not_superuser` for log triage.
 */
export function requireSuperuserGet(params: {
  session: EditSession;
  path: string;
  targetId: string;
}): "not_superuser" | null {
  if (params.session.isSuperuser) return null;
  logEditDenial({
    actorCwid: params.session.cwid,
    targetCwid: params.targetId,
    path: params.path,
    reason: "not_superuser_get",
  });
  return "not_superuser";
}

// ---------------------------------------------------------------------------
// request-origin guard  (defense in depth beyond SameSite=Lax)
// ---------------------------------------------------------------------------

export type OriginCheckResult =
  | { ok: true }
  | { ok: false; reason: "bad_content_type" | "cross_origin" };

/** The minimal request surface `verifyRequestOrigin` reads — a `Request` satisfies it. */
type HeaderCarrier = { headers: { get(name: string): string | null } };

/**
 * An `/api/edit/*` POST must be `application/json` AND same-origin
 * (`self-edit-spec.md` § Authorization — "a cross-site HTML form cannot satisfy
 * both"). `Sec-Fetch-Site` is the primary signal; an older client lacking it
 * falls back to comparing the `Origin` host against `Host`. When neither can
 * be verified the request is rejected — a same-origin `fetch` POST from our
 * own JS always sends `Origin`.
 */
export function verifyRequestOrigin(request: HeaderCarrier): OriginCheckResult {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return { ok: false, reason: "bad_content_type" };
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) {
    return fetchSite === "same-origin" ? { ok: true } : { ok: false, reason: "cross_origin" };
  }

  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host === host) return { ok: true };
    } catch {
      /* malformed Origin header — fall through to reject */
    }
  }
  return { ok: false, reason: "cross_origin" };
}

// ---------------------------------------------------------------------------
// unit-curation predicates  (#540 / ADR-005 Amendment 1 § A1.2)
//
// Role membership is data-derived (a `UnitAdmin` row, not an SSO group) and
// re-checked per POST. The per-unit lookup runs once, returns the actor's
// effective role on that unit, then the pure predicates above consume it.
// This keeps the existing module's "caller fetches, predicate is pure" shape
// (see `authorizeRevoke`) for everything in /api/edit.
// ---------------------------------------------------------------------------

/** The three unit kinds — matches `EntityType` for unit-typed entries. */
export type UnitKind = "department" | "division" | "center";

/**
 * A unit reference for predicate input. `parentDeptCode` is REQUIRED for a
 * division (the dept→division cascade reads it). Callers pass `null` if a
 * division's `deptCode` is unknown — the lookup then treats it as not-found
 * for cascade purposes, never throws.
 */
export type UnitRef =
  | { kind: "department"; code: string }
  | { kind: "division"; code: string; parentDeptCode: string | null }
  | { kind: "center"; code: string };

/**
 * The actor's effective role on a unit, **after** applying the dept→division
 * cascade. `none` means the actor has no `UnitAdmin` row that covers this
 * unit (`canEditUnit` and `canManageAccess` will deny with the appropriate
 * reason). `owner` subsumes `curator` — Amendment 1 § A1.2.
 */
export type EffectiveUnitRole = "owner" | "curator" | "none";

/** Minimal Prisma surface this module reads. Mock-friendly for unit tests. */
export type UnitAdminLookup = {
  unitAdmin: {
    findMany: (args: {
      where: {
        cwid: string;
        OR: Array<{ entityType: "department" | "division" | "center"; entityId: string }>;
      };
      select: { entityType: true; entityId: true; role: true };
    }) => Promise<
      Array<{
        entityType: "department" | "division" | "center";
        entityId: string;
        role: "owner" | "curator";
      }>
    >;
  };
};

/**
 * Look up the actor's effective role on `unit`, applying the dept→division
 * cascade (Amendment 1 § A1.2 — a department-level grant cascades to the
 * department's divisions; division-level does not cascade upward).
 *
 * A Superuser is **not** considered here — superuser access is checked at the
 * predicate level (`canEditUnit` / `canManageAccess`), not by minting a
 * synthetic `owner` row, so the audit log records what role the actor
 * actually held.
 *
 * Single `findMany` covers both the direct row and (for a division) the
 * parent dept row in one query; the in-memory reduction below picks the
 * highest role found.
 */
export async function getEffectiveUnitRole(
  session: EditSession,
  unit: UnitRef,
  db: UnitAdminLookup,
): Promise<EffectiveUnitRole> {
  const lookups: Array<{ entityType: UnitKind; entityId: string }> = [
    { entityType: unit.kind, entityId: unit.code },
  ];
  if (unit.kind === "division" && unit.parentDeptCode) {
    lookups.push({ entityType: "department", entityId: unit.parentDeptCode });
  }

  const rows = await db.unitAdmin.findMany({
    where: { cwid: session.cwid, OR: lookups },
    select: { entityType: true, entityId: true, role: true },
  });

  // Owner > Curator > none. Any owner row wins; otherwise any curator row;
  // otherwise none. The cascade is already encoded by including the parent
  // department in the `OR` — a row in the result implicitly covers the unit.
  let best: EffectiveUnitRole = "none";
  for (const row of rows) {
    if (row.role === "owner") return "owner";
    if (row.role === "curator") best = "curator";
  }
  return best;
}

/**
 * `canEditUnit` — Amendment 1 § A1.2. The actor may edit the unit's
 * `description` / leadership / roster iff Superuser OR Owner OR Curator.
 * Pure given the lookup result. Denial reason `not_curator` matches the
 * SPEC's edge case 10 phrasing ("the actor lacks any unit-admin role").
 */
export function canEditUnit(
  session: EditSession,
  effectiveRole: EffectiveUnitRole,
): AuthzResult {
  if (session.isSuperuser) return ALLOW;
  if (effectiveRole === "owner" || effectiveRole === "curator") return ALLOW;
  return { ok: false, reason: "not_curator" };
}

/**
 * `canManageAccess` — Amendment 1 § A1.2. Granting / revoking a `UnitAdmin`
 * row requires Owner role on the target unit (or Superuser). A Curator can
 * edit but cannot delegate — this is the load-bearing line that keeps
 * Curators from widening their own access via a self-granted Owner row.
 */
export function canManageAccess(
  session: EditSession,
  effectiveRole: EffectiveUnitRole,
): AuthzResult {
  if (session.isSuperuser) return ALLOW;
  if (effectiveRole === "owner") return ALLOW;
  return { ok: false, reason: "not_unit_owner" };
}

/**
 * `canGrant` — Amendment 1 § A1.2 and § A1.3 T1/T2. A Superuser grants any
 * role on any unit. An Owner of unit `V` may grant `owner` or `curator` on
 * `V` (or, by cascade, on `V`'s child divisions when `V` is a department).
 * Two distinct denials so triage can tell them apart:
 *
 *   - `scope_violation`: actor has no role on the target subtree at all —
 *     they are reaching outside their scope (T2).
 *   - `authority_violation`: actor is in scope but holds only Curator —
 *     they cannot delegate (T1, the rule that Curators grant nothing).
 *
 * The split matches Amendment 1 § A1.5 #1 — the event payload also carries
 * the target `role` so an `authority_violation` makes plain *which* role the
 * actor failed to mint.
 */
export function canGrant(
  session: EditSession,
  effectiveRole: EffectiveUnitRole,
  _targetRole: "owner" | "curator",
): AuthzResult {
  if (session.isSuperuser) return ALLOW;
  if (effectiveRole === "none") return { ok: false, reason: "scope_violation" };
  if (effectiveRole === "curator") return { ok: false, reason: "authority_violation" };
  // effectiveRole === "owner": Amendment 1 § A1.4 C — owner→owner is permitted
  // (the deliberate widening; T1/T4 mitigated by the rest of the predicate).
  return ALLOW;
}

// Amendment 1's pure `canProxyEdit` predicate (and its `proxy_target_not_in_unit`
// denial) was RETIRED in Amendment 4 P4. It was never wired into any route — the
// role-derived path a route actually calls is
// `lib/edit/unit-scholar-authz.ts:resolveEditableUnitViaUnitAdmin` — and its
// load-bearing invariant ("roster membership never confers profile-edit rights —
// the whole point of T3") is the deliberate OPPOSITE of Amendment 4 D1, which
// counts the curator-editable `DivisionMembership` roster as conferring
// membership. Keeping a same-axis predicate with contradictory semantics would
// only invite a future miswire, so it was removed rather than left dead.

// ---------------------------------------------------------------------------
// denial telemetry
// ---------------------------------------------------------------------------

/**
 * Emit one `edit_authz_denied` line for a `403` on the edit surface (B02). The
 * route calls this whenever a predicate above returns `{ ok: false }`.
 *
 * Unit-curation callers (#540) pass `targetEntityType` + `targetEntityId` —
 * Amendment 1 § A1.5 #1's generalized event payload — and `role` for grant
 * denials (`authority_violation` / `scope_violation`).
 */
export function logEditDenial(params: {
  actorCwid: string;
  targetCwid: string;
  path: string;
  reason: string;
  targetEntityType?: UnitKind;
  targetEntityId?: string;
  role?: "owner" | "curator";
}): void {
  logAuthzDenied({
    actor_cwid: params.actorCwid,
    target_cwid: params.targetCwid,
    path: params.path,
    reason: params.reason,
    ...(params.targetEntityType ? { target_entity_type: params.targetEntityType } : {}),
    ...(params.targetEntityId ? { target_entity_id: params.targetEntityId } : {}),
    ...(params.role ? { role: params.role } : {}),
  });
}
