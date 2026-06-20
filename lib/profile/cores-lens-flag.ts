/**
 * Cores-lens feature flag. Server-only — read at request time in the profile
 * data layer, so a client component never sees the value: when disabled, the
 * `cores` array is never computed and never flows to the page, so the
 * (CloudFront-cached, public) profile payload carries no core data and no
 * JSON/SEO side channel can leak. Mirrors the Methods-lens master gate
 * (`isMethodsLensEnabled`, lib/profile/methods-lens-flags.ts).
 *
 * Default OFF, so the "Cores used" chip ships dark — safe to merge before the
 * ReciterAI core-usage engine has published any `publication_core` rows. To turn
 * it on in a deployed env, set `CORES_LENS="on"` in BOTH `.env.local` (local)
 * AND the per-env `environment:` block in cdk/lib/app-stack.ts, then
 * `cdk deploy Sps-App-<env>` (CD only re-rolls the image; it does not pick up new
 * env keys) — the flag-parity rule. Wiring it in only one place is a silent
 * shipping bug.
 */
export function isCoresLensEnabled(): boolean {
  return process.env.CORES_LENS === "on";
}
