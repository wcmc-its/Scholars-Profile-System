/**
 * The `suppression.reason` recorded for a self-edit "Not mine" reject (#746) —
 * the discriminator that tells a reject apart from a Hide on the `/edit` read
 * (#750).
 *
 * A reject and a Hide are both per-author publication suppressions written with
 * `contributorCwid === cwid`, so after a page reload they are otherwise
 * indistinguishable. The reject route stamps this exact reason; the `/edit`
 * read (`lib/api/edit-context.ts`) matches it to derive a `rejected` row-state
 * instead of `hidden_by_self`. Keeping the string in one module shared by the
 * write (`app/api/edit/reject/route.ts`) and the read means the two can never
 * silently drift — which is the precise failure #750 is closing.
 */
export const REJECT_REASON = "Rejected as not the author's via /edit (#746)";

/** True when a suppression's `reason` marks it as a "Not mine" reject (#750). */
export function isRejectReason(reason: string | null | undefined): boolean {
  return reason === REJECT_REASON;
}
