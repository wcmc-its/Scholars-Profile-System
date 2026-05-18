/**
 * B02 — authorization-denial telemetry (issue #101).
 *
 * `logAuthzDenied()` emits the one structured log line every `403` from the
 * edit surface produces: `event: "edit_authz_denied"` with the actor, the
 * target, the request path, and a short reason. A CloudWatch metric filter
 * keys an alarm off `event` (`PRODUCTION_ADDENDUM.md` § /api/edit) — a
 * sustained rate is a predicate bug or active probing.
 *
 * Single-line JSON, the same shape B01's callback uses for
 * `saml_callback_failed`, so one metric-filter convention covers both. The
 * per-action predicate (#356, `lib/edit/authz.ts`) calls this at every denial;
 * B02's own mechanism is the source of the `not_superuser` reason.
 */

/** The fields of an `edit_authz_denied` event (`self-edit-spec.md` line 136). */
export interface AuthzDenial {
  /** CWID of the signed-in actor — `session.cwid`. */
  actor_cwid: string;
  /** CWID the action targeted; equals `actor_cwid` for a self-action. */
  target_cwid: string;
  /** Request path the denial occurred on. */
  path: string;
  /** Short stable reason, e.g. `not_superuser`, `not_self`, `not_owner`. */
  reason: string;
}

/** Emit one `edit_authz_denied` log line for a 403 on the edit surface. */
export function logAuthzDenied(denial: AuthzDenial): void {
  console.warn(JSON.stringify({ event: "edit_authz_denied", ...denial }));
}
