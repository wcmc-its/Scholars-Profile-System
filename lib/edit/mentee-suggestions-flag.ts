/**
 * #2634 — `SELF_EDIT_MENTEE_SUGGESTIONS` gates the "Mentees › From your
 * publications" rail sub-view, its loader in `loadEditContext`, and the
 * dismiss/restore routes. Read at request time from the task-def env (a merged
 * flag is dark until `cdk deploy Sps-App-<env>`), same shape as
 * `isCoiGapHintEnabled`.
 */
export function isMenteeSuggestionsEnabled(): boolean {
  return process.env.SELF_EDIT_MENTEE_SUGGESTIONS === "on";
}
