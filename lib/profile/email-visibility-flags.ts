/**
 * Email-visibility feature flag — governs whether the Web Directory release code
 * (`weillCornellEduReleaseCode;mail`, imported to `Scholar.emailVisibility`) is
 * respected across BOTH profile email display and the bulk-export row filter.
 * Server-only (read at request time in the profile data layer and the export
 * route), so a client component never needs the value.
 *
 *   off → current behavior (email shown to everyone; export email column gated
 *         only by viewer-context + hidden-role, not by the release code).
 *   on  → tables A and B of docs/email-visibility-spec.md apply, fail-closed.
 *
 * Defaults OFF, so the gate ships dark. Because `email_visibility` is NULL until
 * the ED ETL backfills it (NULL = 'none' = hide), flip the flag only AFTER the
 * backfill (reindex-then-flip discipline). To turn it on in a deployed env, set
 * the env var to "on" in BOTH `.env.local` (local) AND the per-env `environment:`
 * block in cdk/lib/app-stack.ts, then `cdk deploy Sps-App-<env>` (CD only re-rolls
 * the image; it does not pick up new env keys) — the flag parity rule. Wiring the
 * flag in only one place is a silent shipping bug.
 */
export function isEmailReleaseGateEnabled(): boolean {
  return process.env.PROFILE_EMAIL_RELEASE_GATE === "on";
}
