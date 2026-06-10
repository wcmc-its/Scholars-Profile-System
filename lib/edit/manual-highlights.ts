/**
 * The `SELF_EDIT_MANUAL_HIGHLIGHTS` feature flag (#836; mirrors
 * `isCoiGapHintEnabled` / `isSlugRequestEnabled` / `isReciterRejectEnabled`).
 * Off by default — the opt-in "Choose my highlights manually" surface and the
 * read-time `selectedHighlightPmids` precedence are dormant until ops flip this
 * on.
 *
 * When off:
 *   - the edit route rejects a `selectedHighlightPmids` write (`invalid_field`),
 *   - the read path ignores any stored override and shows the AI selection, and
 *   - the Highlights rail item / card are not surfaced.
 * So the whole feature ships dark and a pre-existing override (were one ever
 * written) is inert until the flag turns on.
 *
 * Wire per-env in `cdk/lib/app-stack.ts` (value "off" in both envs), not just
 * `.env.local`, so local-on/deployed-off can't ship silently (flag parity).
 */
export function isManualHighlightsEnabled(): boolean {
  return process.env.SELF_EDIT_MANUAL_HIGHLIGHTS === "on";
}
