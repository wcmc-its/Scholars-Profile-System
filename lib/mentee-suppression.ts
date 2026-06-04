/**
 * Pure helpers for applying mentee suppressions to the public-profile mentee
 * list (#160 follow-up). The DB read lives in `components/profile/profile-view.tsx`
 * (where db access already is); these pure functions do the
 * derive-hidden-set + filter so the load-bearing logic is unit-testable without
 * rendering the server component, and `lib/api/mentoring.ts` stays
 * reporting-only / pure.
 *
 * A mentee suppression is keyed `entityType="mentee"`,
 * `entityId="{mentorCwid}:{menteeCwid}"` (owner = the mentor). On a mentor's
 * profile we drop any mentee whose `{mentorCwid}:{menteeCwid}` has an active
 * (un-revoked, whole-entity) suppression.
 */

/** The minimal mentee shape the filter needs (a `MenteeChip` satisfies it). */
export type SuppressibleMentee = { cwid: string };

/** The minimal suppression-row shape the derive needs. */
export type MenteeSuppressionRow = { entityId: string };

/**
 * Build the set of menteeCwids this mentor has hidden, from the suppression
 * rows whose `entityId` is prefixed `"{mentorCwid}:"`. Defensive: a row that
 * does not start with the expected prefix is ignored (it isn't this mentor's).
 */
export function hiddenMenteeCwids(
  mentorCwid: string,
  rows: readonly MenteeSuppressionRow[],
): Set<string> {
  const prefix = `${mentorCwid}:`;
  const hidden = new Set<string>();
  for (const r of rows) {
    if (!r.entityId.startsWith(prefix)) continue;
    const menteeCwid = r.entityId.slice(prefix.length);
    if (menteeCwid) hidden.add(menteeCwid);
  }
  return hidden;
}

/**
 * Drop mentees whose cwid is in the hidden set. Used BEFORE computing the
 * profile's mentee count + degree distribution so the header reflects only
 * what's shown.
 */
export function filterHiddenMentees<T extends SuppressibleMentee>(
  mentees: readonly T[],
  hidden: ReadonlySet<string>,
): T[] {
  return mentees.filter((m) => !hidden.has(m.cwid));
}
