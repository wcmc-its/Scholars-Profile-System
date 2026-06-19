/**
 * Feature flag for the Cancer Center collaboration network (#1137).
 *
 * Default OFF. Gates the public "Collaboration" tab + its uncacheable data route.
 * The tab is ADDITIONALLY gated, data-driven, on the center having a
 * `CenterProgram` taxonomy (today only the Meyer Cancer Center) — so "just the
 * Cancer Center for now" needs no hardcoded center code.
 *
 * Server-only (reads `process.env`); do not import from the client component.
 * Per the flag-parity rule, wire in BOTH `.env.local` AND the per-env
 * `environment:` block in `cdk/lib/app-stack.ts` (staging "on" / prod "off").
 */
export function isCenterCollaborationNetworkEnabled(): boolean {
  return process.env.CENTER_COLLABORATION_NETWORK === "on";
}
