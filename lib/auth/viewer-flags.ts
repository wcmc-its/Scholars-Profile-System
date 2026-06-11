/**
 * #866 — feature flag for the internal-viewer NETWORK signal. Server-only (read
 * at request time in lib/auth/viewer-context.ts), so a client component never
 * needs the value — when off, the source-IP branch is skipped entirely and an
 * unauthenticated viewer is treated as external regardless of their network.
 *
 * Defaults OFF, so the network signal ships dark: until it is on, "internal"
 * means "has a valid session" and nothing else. To turn it on in a deployed env,
 * set the env var to "on" in BOTH `.env.local` (local) AND the per-env
 * `environment:` block in cdk/lib/app-stack.ts, then `cdk deploy Sps-App-<env>`
 * (CD only re-rolls the image; it does not pick up new env keys) — the flag
 * parity rule. Wiring the flag in only one place is a silent shipping bug.
 *
 * The companion `INTERNAL_VIEWER_CIDRS` (comma-separated IPv4 CIDRs) is the data
 * this gate consumes; it is read directly from `process.env` in viewer-context.ts
 * (an empty / unset list means no IP ever matches, so the gate stays fail-safe
 * even when this flag is on).
 */

/**
 * Master gate for the source-IP "on the WCM network" branch of the internal
 * viewer predicate. When off, `resolveViewerContext` never inspects the request
 * IP — only a valid session can make a viewer internal. When on, an
 * unauthenticated request whose CloudFront source IP is inside any
 * `INTERNAL_VIEWER_CIDRS` entry is treated as an internal viewer.
 */
export function isInternalViewerNetworkSignalOn(): boolean {
  return process.env.INTERNAL_VIEWER_NETWORK_SIGNAL === "on";
}
