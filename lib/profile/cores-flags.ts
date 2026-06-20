/**
 * Feature flags for the public core-facility surfaces. Both server-only and read
 * at request time, so a client component never sees the value: when a flag is
 * off, the corresponding data is never computed and never flows to the page (no
 * JSON/SEO side channel). Both default OFF, so each surface ships dark — safe to
 * merge before the ReciterAI core-usage engine has published any `publication_core`
 * rows.
 *
 * Unlike the Methods lens there is no master "data" gate: the cores substrate
 * (`publication_core`) is simply empty until the ETL/engine populates it, so each
 * surface flag stands alone.
 *
 * To turn either on in a deployed env, set the env var to "on" in BOTH
 * `.env.local` (local) AND the per-env `environment:` block in
 * cdk/lib/app-stack.ts, then `cdk deploy Sps-App-<env>` — the flag-parity rule.
 * Wiring a flag in only one place is a silent shipping bug.
 */

/**
 * Gates the "Core facilities" section in the publication detail modal (per-pmid).
 * Off ⇒ `resolvePublicationCores` returns `[]`, the section omits, and the modal
 * payload carries no core data.
 */
export function isCorePubModalEnabled(): boolean {
  return process.env.CORE_PUB_MODAL === "on";
}

/**
 * Gates the public per-core pages (`/cores/[coreId]`). Off ⇒ the route
 * `notFound()`s and no inbound link to it is rendered (e.g. the modal renders a
 * core name as plain text rather than a dead link).
 */
export function isCorePagesEnabled(): boolean {
  return process.env.CORE_PAGES === "on";
}
