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

/**
 * The `GRANT_MATCHA` feature flag (Grant Matcha — convergence plan 2026-07-22, increment 1).
 * Off by default. When on, the `/edit/find-researchers` matched view gains a "Matcha" mode
 * that ranks researchers for the selected opportunity through the Matcha spine (extractor →
 * per-concept OpenSearch fan-out → RRF fuse) instead of the structured topic-vector matcher —
 * seeding the ask from the opportunity's title + synopsis. The existing topic-vector view stays
 * the default; this is a strict, reversible add (the retire-gate hasn't cleared).
 *
 * Depends on `MATCHA` being on in the env: the Matcha mode POSTs to `/api/edit/matcha`, which
 * `isMatchaEnabled()` gates. Wire per-env in `cdk/lib/app-stack.ts` (value "off" in both envs,
 * flip staging on to activate), not just `.env.local`, so local-on / deployed-off can't ship
 * silently (flag parity).
 */
export function isGrantMatchaEnabled(): boolean {
  return process.env.GRANT_MATCHA === "on";
}
