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

/**
 * Sub-flag for the grant co-investigator axis (#1137 Phase 2). Default OFF.
 *
 * Gates ONLY the second relationship axis (grant awards) inside the tab: when
 * off, the loader emits no `awards` and the component shows the publication
 * network exactly as Phase 1. Separate from the parent flag so the grant axis
 * can soak independently and ship dark to prod while the pub axis stays live.
 * The parent `CENTER_COLLABORATION_NETWORK` still gates the whole tab — this
 * has no effect unless the parent is also on.
 *
 * Server-only; wire in BOTH `.env.local` AND `cdk/lib/app-stack.ts` (staging
 * "on" / prod "off"), per the flag-parity rule.
 */
export function isCenterCollaborationGrantAxisEnabled(): boolean {
  return process.env.CENTER_COLLABORATION_GRANT_AXIS === "on";
}
