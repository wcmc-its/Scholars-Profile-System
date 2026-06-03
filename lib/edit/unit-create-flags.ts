/**
 * Org-unit creation flags (#728 Phase D, `ed-admin-org-unit-roles-spec.md`
 * § 4.5). The lockdown gate for the one remaining non-superuser create path
 * (`createInformalCenter`'s default-`center` branch).
 *
 * Read lazily inside the helper (never at module load), per the repo convention
 * (mirrors `isAdministratorsTabEnabled` / `isSlugRequestEnabled`). Off by
 * default so the behavior change — an Owner of a parent department loses
 * informal-center creation — is opt-in and can ship dark pending stakeholder
 * confirmation (OQ-8a).
 */

/**
 * Whether org-unit creation is locked to superusers only (#728 Phase D § 4.5).
 * Off by default: the existing `canManageAccess` (Owner-of-parent-dept OR
 * Superuser) path for informal centers is preserved. When `"on"`, the
 * `createInformalCenter` default-`center` branch narrows to `session.isSuperuser`
 * and the `/edit/unit/new` form offers the "Request a new org unit" affordance to
 * a non-superuser instead of the center form.
 */
export function isOrgUnitCreateSuperuserOnly(): boolean {
  return process.env.SELF_EDIT_ORG_UNIT_CREATE_SUPERUSER_ONLY === "on";
}
