/**
 * `core_director` role resolution: the Cores director is Owner of EVERY core
 * facility, current and future, with no per-core `unit_admin` grant, and may
 * open the all-cores report roll-up.
 *
 * The only source is a manual `core_director` row in `functional_role_grant`
 * (Administrators page, Functional roles tab), read only while
 * `FUNCTIONAL_ROLES_AUTHZ` is "on". Flag off, an empty cwid or a failed read
 * all resolve to `false` (fail-closed); nothing else confers the role.
 *
 * Resolved ONCE per request onto `EditSession.isCoreDirector` by
 * `getEditSession()` / `getEffectiveEditSession()` (the latter for the
 * EFFECTIVE cwid, so "View as" shows the target's verdict, not the real
 * user's). The gates then read the session flag, never the table:
 * `getFlatUnitRole` answers "owner" for any core (so every
 * `getCoreOwnerRole` caller and the core branch of `/api/edit/grant` pick it
 * up), `canViewAllCores` admits the holder, and the unit listings
 * (`loadManageableUnits`, `loadOwnerManagedUnitScope`) enumerate every core.
 *
 * The registry module is loaded with a dynamic `import()` only when the flag
 * is on, so importers of this module (the session path) do not construct the
 * DB client just by importing it. Never import from a `"use client"`
 * component or the Edge middleware.
 */
import { cache } from "react";

export const isCoreDirector = cache(async (cwid: string): Promise<boolean> => {
  if (process.env.FUNCTIONAL_ROLES_AUTHZ !== "on" || !cwid) return false;
  try {
    const { registryAdmitsCoreDirector } = await import("@/lib/auth/functional-role-authz");
    return await registryAdmitsCoreDirector(cwid);
  } catch {
    return false;
  }
});
