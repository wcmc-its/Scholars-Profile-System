/**
 * The `SELF_EDIT_ORCID_SUGGESTION` feature flag (mirrors `isReciterPendingHintEnabled`).
 * On → (1) the home board's ORCID row shows the scholar's inferred iD from
 * `orcid_candidate` and an RPM-admin iD counts as on file; (2) the Identifiers &
 * Profiles tab is in the rail and `POST /api/edit/orcid` accepts writes
 * (`scholar.orcid` + `orcid_confirmed_at`, which `etl:orcid-push` carries to WCM
 * Identity), which is why the whole surface shares one kill switch. Off → the home row still renders from `scholar.orcid`
 * alone, its CTA and Name & Title hand off to ReCiter Manage Profile as before,
 * the tab is absent, and the route 404s.
 *
 * Wired per-env in `cdk/lib/app-stack.ts` (staging on, prod off until the staging
 * soak), not just `.env.local` (flag parity).
 */
export function isOrcidSuggestionEnabled(): boolean {
  return process.env.SELF_EDIT_ORCID_SUGGESTION === "on";
}
