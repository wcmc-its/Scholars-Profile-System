/**
 * Canonical WCM CWID shape — the single source of truth for "is this a CWID?".
 *
 * A CWID is a lowercase letter followed by 2–8 lowercase alphanumerics (3–9
 * chars total). This deliberately covers BOTH the common `aaa1234` shape AND the
 * name-derived "vanity" ids the directory issues (`nkaltork`, `formenti`,
 * `mtalmor`, `barany`) — the latter have no trailing digits and were silently
 * dropped by older, narrower `^[a-z]{3}[0-9]{4}$` regexes (which cost a real
 * import 37 members). Reused by the /edit validators (interactive roster writes)
 * and the membership-import backfills so a CWID is never "valid in the editor,
 * invalid in the importer". Keep this in lockstep with `lib/edit/validators.ts`,
 * which re-exports it.
 *
 * NOT exhaustive identity validation: a syntactically valid CWID need not resolve
 * to a known person. Callers that require existence check the `scholar`/identity
 * tables separately.
 */
export const CWID_PATTERN = /^[a-z][a-z0-9]{2,8}$/;

/** Whether `value` is a syntactically valid CWID (see {@link CWID_PATTERN}). */
export function isCwid(value: string): boolean {
  return CWID_PATTERN.test(value);
}
