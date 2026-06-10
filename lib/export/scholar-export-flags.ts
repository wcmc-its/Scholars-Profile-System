/**
 * #847 — feature flag for the internal "download the leading scholars" CSV
 * export. Server-only (read at request time in the export route + the server
 * components that render the download island), so a client component never needs
 * the value — when disabled, the route 404s and the button is never rendered
 * into the (CloudFront-cached) HTML.
 *
 * Defaults OFF, so the feature ships dark. To turn it on in a deployed env, set
 * the env var to "on" in BOTH `.env.local` (local) AND the per-env
 * `environment:` block in cdk/lib/app-stack.ts, then `cdk deploy Sps-App-<env>`
 * (CD only re-rolls the image; it does not pick up new env keys) — the flag
 * parity rule. Wiring the flag in only one place is a silent shipping bug.
 */

/**
 * Master gate for the scholar-list CSV export (button render + endpoint). When
 * off, the POST route 404s and the server components skip rendering the download
 * client island entirely, so the flag-off cached HTML never carries it. The
 * method-scoped exports are ADDITIONALLY gated by `isMethodPagesEnabled()`.
 */
export function isScholarListExportEnabled(): boolean {
  return process.env.SCHOLAR_LIST_EXPORT === "on";
}
