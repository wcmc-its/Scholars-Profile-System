/**
 * The `UNIT_ADMIN_CENTER_PROXY` feature flag (#1104; mirrors
 * `isManualHighlightsEnabled` / `isCoiGapHintEnabled`). Off by default — the
 * center extension of the Amendment 4 unit-admin proxy path (decision D1, which
 * deliberately EXCLUDED centers) is dormant until ops flip this on.
 *
 * When off, the center membership leg in both
 * `resolveEditableUnitViaUnitAdmin` and `listUnitAdminEditorsForScholar`
 * (`lib/edit/unit-scholar-authz.ts`) is skipped entirely — no `CenterMembership`
 * read is issued and no `center` unit is ever resolved — so the dept/division
 * behavior is byte-identical to today and a center owner/curator gains NOTHING
 * via this path. Prod stays dark.
 *
 * Wire per-env in `cdk/lib/app-stack.ts` (value "off" in both envs), not just
 * `.env.local`, so local-on/deployed-off can't ship silently (flag parity).
 */
export function isUnitAdminCenterProxyEnabled(): boolean {
  return process.env.UNIT_ADMIN_CENTER_PROXY === "on";
}
