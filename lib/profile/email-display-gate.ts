/**
 * Pure table-A gate for whether a scholar's email may be rendered to a viewer,
 * given the imported Web Directory release audience (`Scholar.emailVisibility`)
 * and whether the viewer is internal (#866: authenticated session OR allowlisted
 * WCM network — see lib/auth/viewer-context.ts).
 *
 * Table A (docs/email-visibility-spec.md § A):
 *
 *   email_visibility | external (anon off-campus) | internal (session OR on-net)
 *   -----------------|---------------------------|------------------------------
 *   public           | show                      | show
 *   institution      | hide                      | show
 *   none / null       | hide                      | hide
 *
 * Fail-closed: any value that is not exactly "public" or "institution" — NULL,
 * "none", or an unrecognized string — is treated as "never show". The ETL parser
 * (`parseEmailReleaseAudience`) already normalizes to {public,institution,none},
 * so this mirrors that contract and stays safe if the column is NULL (pre-backfill)
 * or carries an unexpected value.
 *
 * This module is pure (no flag read, no request access) so it is trivially
 * unit-testable and shared by both the profile loader and the scholar-list API.
 * The CALLER decides whether the gate is active (it runs only when
 * `isEmailReleaseGateEnabled()` is on; when off, callers keep today's behavior
 * and show the email to everyone).
 */
export function isEmailVisibleToViewer(
  emailVisibility: string | null | undefined,
  internalViewer: boolean,
): boolean {
  if (emailVisibility === "public") return true;
  if (emailVisibility === "institution") return internalViewer;
  // "none", NULL, or any unrecognized value → never shown (fail-closed).
  return false;
}

/**
 * Apply table A to a raw email, returning the email to serialize or `null` when
 * it must be withheld so it never reaches the client. `gateEnabled` is the
 * `isEmailReleaseGateEnabled()` value: when false, the legacy behavior is
 * preserved (the email is returned unchanged, shown to everyone).
 */
export function gateEmailForViewer(
  email: string | null | undefined,
  emailVisibility: string | null | undefined,
  internalViewer: boolean,
  gateEnabled: boolean,
): string | null {
  const value = email ?? null;
  if (!gateEnabled) return value;
  return isEmailVisibleToViewer(emailVisibility, internalViewer) ? value : null;
}
