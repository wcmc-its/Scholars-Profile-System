/**
 * #1103 — scholar-profile "Centers" card feature flag. Surfaces a scholar's
 * ACTIVE center memberships (the reverse of the center page roster) as a
 * sidebar card. Server-read at request time in the profile data layer and
 * threaded into the payload, so a client component never reads the value: when
 * the flag is OFF, the loader skips the reverse query entirely and the payload
 * carries `centers: []`, so nothing renders and the output is byte-identical to
 * today.
 *
 * This is a PRISMA-SOURCED DISPLAY surface only — it adds NO search-index or
 * browse facet key (per #1074/#1076, center PROGRAMS must never enter the
 * dept/division/center browse facet).
 *
 * Default OFF, so the card ships dark. To turn it on in a deployed env, set
 * `PROFILE_CENTER_AFFILIATION` to "on" in BOTH `.env.local` (local) AND the
 * per-env `environment:` block in cdk/lib/app-stack.ts, then
 * `cdk deploy Sps-App-<env>` (CD only re-rolls the image; it does not pick up
 * new env keys) — the flag-parity rule. Wiring the flag in only one place is a
 * silent shipping bug.
 */
export function isProfileCenterAffiliationEnabled(): boolean {
  return process.env.PROFILE_CENTER_AFFILIATION === "on";
}
