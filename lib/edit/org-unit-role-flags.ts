/**
 * Org-unit role vocabulary console flags (#2542 Phase 3, `lib/org-unit-roles.ts`).
 * The lockdown gate for the steward-owned `OrgUnitRole` editor — read + update +
 * create, no delete.
 *
 * Read lazily inside each helper (never at module load), per the repo
 * convention (mirrors `isOrgUnitCreateSuperuserOnly` / `isCommsStewardEnabled`).
 * Off by default so the surface ships dark until a manual `cdk deploy`.
 *
 * SERVER-ONLY. Never import this from a client component — `lib/org-unit-
 * roles.ts` is dependency-free specifically so it can be reached from the
 * client bundle (`components/edit/home-panel.tsx`), and this module's `process
 * .env` read would break that if it ever ended up on the same import path.
 */
import { type EditSession } from "@/lib/auth/superuser";

/**
 * Whether the org-unit role vocabulary console is enabled at all — the master
 * kill switch. Off by default: dark until a superuser / comms_steward surface
 * for `OrgUnitRole` is ready to ship.
 */
export function isOrgUnitRoleConsoleEnabled(): boolean {
  return process.env.ORG_UNIT_ROLE_CONSOLE === "on";
}

/**
 * Whether to advertise the console tab / route for this viewer: the surface is
 * enabled AND the viewer can reach it (a superuser or a comms_steward — the
 * same tier `authorizeCommsStewardAction` grants on the write routes). Mirrors
 * the `isXTabVisible` convention documented above `TAB_PREDICATES` in
 * `lib/edit/console-tabs.server.ts`, so nav and page share ONE gate.
 */
export function isOrgUnitRoleConsoleTabVisible(session: EditSession): boolean {
  return isOrgUnitRoleConsoleEnabled() && (session.isSuperuser || session.isCommsSteward);
}
