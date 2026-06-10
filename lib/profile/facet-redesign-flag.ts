/**
 * Scholar-profile facet-filter redesign (PR-2) — feature flag. Server-read at
 * request time on the profile page and threaded down as a prop, so a client
 * component never reads the value itself: when the flag is OFF, the redesign
 * branch is simply never entered and the rendered output is byte-identical to
 * today (every existing unit test still passes untouched).
 *
 * Default OFF, so the redesign ships dark. To turn it on in a deployed env, set
 * `PROFILE_FACET_REDESIGN` to "on" in BOTH `.env.local` (local) AND the per-env
 * `environment:` block in cdk/lib/app-stack.ts, then `cdk deploy Sps-App-<env>`
 * (CD only re-rolls the image; it does not pick up new env keys) — the
 * flag-parity rule. Wiring the flag in only one place is a silent shipping bug.
 */
export function isProfileFacetRedesignEnabled(): boolean {
  return process.env.PROFILE_FACET_REDESIGN === "on";
}
