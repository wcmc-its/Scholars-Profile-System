/**
 * The `SELF_EDIT_RECITER_PENDING_HINT` feature flag (mirrors
 * `isCoiGapHintEnabled` / `isSlugRequestEnabled`). Off by default — the
 * self-only "publications may be missing from your profile" nudge that points
 * the scholar at ReCiter's pending/suggested candidate publications is dormant
 * until ops flip this on.
 *
 * Ships INERT: the flag is off in BOTH envs AND the backing
 * `reciter_pending_suggestion` table is empty (no ETL populates it yet), so the
 * surface renders nothing even with the flag on.
 *
 * Wired per-env in `cdk/lib/app-stack.ts` (value "off" in both envs), not just
 * `.env.local`, so local-on/deployed-off can't ship silently (flag parity).
 */
export function isReciterPendingHintEnabled(): boolean {
  return process.env.SELF_EDIT_RECITER_PENDING_HINT === "on";
}
