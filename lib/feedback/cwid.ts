/**
 * Validate + normalize a user-typed CWID for the feedback form (#538
 * Q10). The CWID is optional; this returns `null` for empty input and
 * `null` for any input that doesn't match the documented shape.
 *
 * **Distinct from session-derived CWID handling**: the auth path
 * (`lib/auth/`) presumes the CWID is SSO-signed and rejects invalid
 * values up front. Here the CWID is user-typed — invalid input is
 * silently dropped to `NULL` rather than rejecting the whole submission,
 * because the form is anonymous-by-default and we'd rather lose the
 * follow-up handle than the rest of the response.
 */

const CWID_PATTERN = /^[a-z0-9]{2,16}$/;

export function normalizeUserCwid(input: string | null | undefined): string | null {
  if (input == null || typeof input !== "string") return null;
  const lowered = input.trim().toLowerCase();
  if (!lowered) return null;
  return CWID_PATTERN.test(lowered) ? lowered : null;
}
