/**
 * The `SELF_EDIT_ORCID_SUGGESTION` feature flag (mirrors `isReciterPendingHintEnabled`).
 * On → the self-edit home board's ORCID row and the Name & Title ORCID value show
 * the scholar's strong-inferred iD ("Is this your ORCID iD?") from `orcid_candidate`,
 * and an RPM-admin iD counts as on file. Off → the row still renders (on file / not
 * on file from `scholar.orcid` alone) and never reads `orcid_candidate`.
 *
 * Wired per-env in `cdk/lib/app-stack.ts` (staging on, prod off until the
 * `pubsource_orcid_person` refresh has landed), not just `.env.local` (flag parity).
 */
export function isOrcidSuggestionEnabled(): boolean {
  return process.env.SELF_EDIT_ORCID_SUGGESTION === "on";
}
