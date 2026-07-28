// Arm → env for the MATCHA_GLOSS_RERANK λ-sweep (docs/2026-07-22-gloss-rerank-eval-runbook.md).
//
// The in-VPC vehicle varies exactly ONE thing between arms: the gloss rescore. `base` leaves it
// off (today's ordering, the ablation); `gloss-<λ>` turns it on at that `rescore_query_weight`.
// This lives in its own module — NOT in spine-eval-run.ts — because that file self-executes
// `main()` on import, so the self-check could not import a helper defined there. Keeping the arm
// names in ONE place is load-bearing: if a base arm and a gloss arm silently produced the same
// env, the sweep would read as "λ had no effect" (a false-negative kill), not as a bug.
export function glossArmEnv(
  arm: string,
): { MATCHA_GLOSS_RERANK?: string; MATCHA_GLOSS_RERANK_LAMBDA?: string } {
  const m = /^gloss-([0-9]*\.?[0-9]+)$/.exec(arm);
  if (m) return { MATCHA_GLOSS_RERANK: "on", MATCHA_GLOSS_RERANK_LAMBDA: m[1] };
  return {}; // base — or any non-gloss arm — leaves the rescore off
}
