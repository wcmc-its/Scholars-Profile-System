/**
 * The gate-side reads of `functional_role_grant`, behind the
 * `FUNCTIONAL_ROLES_AUTHZ` flag.
 *
 * ADDITIVE ONLY. Each function here answers "does the registry ALSO admit
 * this person?"; every caller ORs it onto its existing verdict, so turning the
 * flag on can widen access but never narrow it:
 *   - `isCommsSteward` (`lib/auth/comms-steward.ts`) also admits an
 *     `external_affairs` grant carrying the Communications function;
 *   - `isDeveloper` (`lib/auth/development.ts`) also admits an
 *     `external_affairs` grant carrying the Development function;
 *   - the report gate (`loadReportScopesForCwid` / `hasAnyReportAccess`,
 *     `lib/edit/report-access.ts`) also admits a `reporting` grant, per scope.
 * Every source counts (manual rows and imported ones alike): an imported row
 * mirrors a source that already grants the same access.
 *
 * While the flag is not exactly "on", nothing here touches the database.
 * Fail-closed: a failed read (the table missing in an env, a DB error) is
 * logged and admits nobody, so the caller's existing verdict stands.
 *
 * Server-only (reads `@/lib/db`). `comms-steward.ts` and `development.ts`
 * load this module with a dynamic `import()` only when the flag is on, so
 * their existing importers (the session path, the impersonation routes) do
 * not construct the DB client just by importing them. Never import it from a
 * `"use client"` component or the Edge middleware.
 */
import { db } from "@/lib/db";
import {
  reportScopesFromRegistry,
  scopesCarryFunction,
  scopesFromJson,
  type ExternalAffairsFunction,
} from "@/lib/edit/functional-roles";

/** `FUNCTIONAL_ROLES_AUTHZ` must be exactly "on"; anything else (unset,
 *  "off") leaves the registry tracking-only. */
export function isFunctionalRolesAuthzEnabled(): boolean {
  return process.env.FUNCTIONAL_ROLES_AUTHZ === "on";
}

function logReadFailed(check: string, err: unknown): void {
  console.warn(
    JSON.stringify({
      event: "functional_role_authz_read_failed",
      check,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

/** Every scope list `cwid` holds for `role`, across sources. */
async function registryScopes(role: string, cwid: string): Promise<string[][]> {
  const rows = await db.read.functionalRoleGrant.findMany({
    where: { role, cwid: cwid.toLowerCase() },
    select: { scopes: true },
  });
  return rows.map((r) => scopesFromJson(r.scopes));
}

/** Whether the registry gives `cwid` an External Affairs grant carrying `fn`.
 *  False when the flag is off, the cwid is empty, or the read fails. */
export async function registryAdmitsExternalAffairs(
  cwid: string,
  fn: ExternalAffairsFunction,
): Promise<boolean> {
  if (!isFunctionalRolesAuthzEnabled() || !cwid) return false;
  try {
    const held = await registryScopes("external_affairs", cwid);
    return held.some((s) => scopesCarryFunction(s, fn));
  } catch (err) {
    logReadFailed(`external_affairs:${fn}`, err);
    return false;
  }
}

/** The `report_access`-shaped scope keys the registry gives `cwid` on
 *  `reportKey` (`"*"` = whole report). Empty when the flag is off or the read
 *  fails. */
export async function registryReportScopes(cwid: string, reportKey: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!isFunctionalRolesAuthzEnabled() || !cwid) return out;
  try {
    for (const scopes of await registryScopes("reporting", cwid)) {
      for (const s of reportScopesFromRegistry(scopes, reportKey)) out.add(s);
    }
  } catch (err) {
    logReadFailed(`reporting:${reportKey}`, err);
  }
  return out;
}

/** Whether the registry gives `cwid` any Reporting grant (the "has any report
 *  access" way in to `/edit` and the console's Reports tab). */
export async function registryHasAnyReporting(cwid: string): Promise<boolean> {
  if (!isFunctionalRolesAuthzEnabled() || !cwid) return false;
  try {
    return (await registryScopes("reporting", cwid)).some((s) => s.length > 0);
  } catch (err) {
    logReadFailed("reporting:any", err);
    return false;
  }
}
