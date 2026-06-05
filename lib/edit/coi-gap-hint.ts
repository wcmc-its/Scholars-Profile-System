/**
 * The `SELF_EDIT_COI_GAP_HINT` feature flag (mirrors `isSlugRequestEnabled` /
 * `isReciterRejectEnabled`). Off by default — the self-only "From your
 * publications" panel and its disavow endpoint are dormant until ops flip this
 * on.
 *
 * Two independent gates must clear before this is ever turned on (see
 * `docs/coi-pubmed-HANDOFF.md` § C): (1) Faculty Affairs / Compliance / General
 * Counsel sign-off on the concept AND the exact copy, and (2) a measured
 * High-tier precision number ratified with Compliance. Until both clear the flag
 * stays "off" in BOTH staging and prod — this is NOT a staging-first rollout
 * (the copy is approvable, the precision number is not).
 *
 * Wired per-env in `cdk/lib/app-stack.ts` (value "off" in both envs), not just
 * `.env.local`, so local-on/deployed-off can't ship silently (flag parity).
 */
export function isCoiGapHintEnabled(): boolean {
  return process.env.SELF_EDIT_COI_GAP_HINT === "on";
}
