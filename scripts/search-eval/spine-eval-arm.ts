// Arm → env for the MATCHA_GLOSS_RERANK λ-sweep: the offline eval that gates the flag, run as
// arms `base` / `gloss-0.25` / `gloss-0.5` / `gloss-1.0` over the sponsor fixtures. It splits
// across two environments because neither has both dependencies — extraction needs Bedrock
// (laptop; the `sps-etl` role has no Bedrock grant), retrieval needs OpenSearch (in-VPC only) —
// and the in-VPC image must already CONTAIN the rescore code, since the flags are supplied per
// arm at run time but the code is not: a stale image makes every arm run the base path.
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
