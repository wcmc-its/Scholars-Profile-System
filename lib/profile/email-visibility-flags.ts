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

/**
 * Whether a scholar's email may be emitted in a CSV export under their Web
 * Directory release code (SPEC §B.2). When the release gate is OFF this is
 * always true (legacy behavior — email gated only by viewer-context +
 * hidden-role). When ON the email is exportable only for `public` /
 * `institution`; `none` and NULL (the fail-closed default until the ED ETL
 * backfills `email_visibility`) blank the cell. Any internal viewer who clears
 * the channel gate sees institution + public alike, so the looser display
 * audience is irrelevant here.
 *
 * Lives here — NOT in `lib/api/export-scholars.ts` — because the unit-roster
 * export (`lib/edit/unit-roster-export.ts`) reaches the CLIENT bundle via
 * `components/edit/unit-edit-page.tsx`, and `export-scholars.ts` constructs
 * `prisma` at module scope. This module is env-reads only, so both export
 * surfaces can share ONE definition of the release-code rule without dragging
 * the driver into the browser build. Two copies of a consent predicate is two
 * places for it to drift.
 */
export function isEmailExportableByReleaseCode(emailVisibility: string | null): boolean {
  if (!isEmailReleaseGateEnabled()) return true;
  return emailVisibility === "public" || emailVisibility === "institution";
}
