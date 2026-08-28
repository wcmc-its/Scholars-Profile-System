/**
 * The `UNIT_ADMIN_CENTER_PROXY` feature flag (#1104; mirrors
 * `isManualHighlightsEnabled` / `isCoiGapHintEnabled`). The center extension of
 * the Amendment 4 unit-admin proxy path (decision D1, which deliberately
 * EXCLUDED centers).
 *
 * LIVE — `"on"` in BOTH envs since 2026-07-05 (`cdk/lib/app-stack.ts`, a shared
 * line with no per-env ternary). This block used to read "off by default …
 * prod stays dark"; that has been false since the flip, and it read as an
 * assurance that the escalation below is inert. It is not.
 *
 * When off, the center membership leg in both
 * `resolveEditableUnitViaUnitAdmin` and `listUnitAdminEditorsForScholar`
 * (`lib/edit/unit-scholar-authz.ts`) is skipped entirely — no `CenterMembership`
 * read is issued and no `center` unit is ever resolved. Being ON, a center
 * owner/curator CAN add an arbitrary scholar to their roster and thereby gain
 * the bounded `overview` + own-publication-hide proxy edit on that scholar, for
 * as long as the membership is date-current.
 *
 * Since #2544 the creator of a center is seeded as its Owner
 * (`app/api/edit/unit/route.ts`), so that capability is reachable WITHOUT a
 * Superuser grant: a department Owner can create a center and self-serve into
 * the proxy path. Bounded and fully audited (B03 rows carry the real
 * `actor_cwid`), and an accepted risk under ADR-005 Amendment 4 § Threat model
 * — but self-service, which the Amendment did not contemplate.
 *
 * Wire per-env in `cdk/lib/app-stack.ts`, not just `.env.local`, so
 * local-on/deployed-off can't ship silently (flag parity).
 */
export function isUnitAdminCenterProxyEnabled(): boolean {
  return process.env.UNIT_ADMIN_CENTER_PROXY === "on";
}
