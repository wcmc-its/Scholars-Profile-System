/**
 * The `SELF_EDIT_GRANT_RECS` feature flag (GrantRecs Phase 3; mirrors
 * `isManualHighlightsEnabled` / `isCoiGapHintEnabled` / `isSlugRequestEnabled`).
 * Off by default — the owner-facing "Grants for me" rail item + panel on the
 * `/edit` self-edit surface (and the superuser `/edit/scholar/[cwid]` surface)
 * are dormant until ops flip this on.
 *
 * When off the `grant-recs` attribute is dropped from both the rail and the
 * valid-attr set, so `?attr=grant-recs` canonicalizes away and the feature ships
 * fully dark. The underlying public route (`/api/scholars/[cwid]/opportunities`)
 * is unaffected — the flag only governs the edit-surface entry point.
 *
 * Wire per-env in `cdk/lib/app-stack.ts` (value "off" in both envs), not just
 * `.env.local`, so local-on / deployed-off can't ship silently (flag parity).
 */
export function isGrantRecsEnabled(): boolean {
  return process.env.SELF_EDIT_GRANT_RECS === "on";
}
