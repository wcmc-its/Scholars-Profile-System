/**
 * Bedrock model ids + capability predicates (#2123). Two distinct defaults are
 * in use — DO NOT unify them into one constant, they are independent,
 * IAM-scoped rollback levers:
 *
 *   - `DEFAULT_GENERATE_MODEL` (Opus 4.8) — shared by the overview generator,
 *     the biosketch generator, and the CV research-summary call, via the
 *     `OVERVIEW_GENERATE_MODEL` / `BIOSKETCH_GENERATE_MODEL` env overrides.
 *   - `DEFAULT_EXTRACT_MODEL` (Sonnet 4.5) — Matcha concept extraction only,
 *     via the `MATCHA_EXTRACT_MODEL` env override. Sonnet, not Opus, because a
 *     short structured extraction doesn't need Opus and, unlike Opus 4.7/4.8,
 *     Sonnet accepts an explicit `temperature` — Matcha pins 0 for
 *     near-deterministic extraction.
 *
 * Both ids are matched by a `TaskRoleBedrockPolicy` IAM resource glob
 * (`cdk/lib/app-stack.ts` ~774-777): an intra-family minor-version bump (e.g.
 * 4.5 → 4.6) needs no policy change, but changing the FAMILY (opus ↔ sonnet)
 * does. Both env var names are registered in
 * `scripts/release/flag-parity-allowlist.txt` as deliberately-not-wired-per-env
 * rollback levers (unset ⇒ the default below in every env) — do not rename
 * either env var, and re-run the flag-parity gate after touching this file.
 */
export const DEFAULT_GENERATE_MODEL = "us.anthropic.claude-opus-4-8";
export const DEFAULT_EXTRACT_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

/**
 * Opus 4.7 / 4.8 and Fable REJECT an explicit `temperature` on Bedrock (HTTP
 * 400). Gate the param so those models run; every other model (incl. Sonnet)
 * keeps its tuned temperature. `thinking` stays unset regardless.
 */
export function modelAcceptsTemperature(modelId: string): boolean {
  return !/claude-(opus-4-[78]|fable)/.test(modelId);
}
