/**
 * Effective feature-flag values as THIS running task sees them (#1765).
 *
 * A merged flag stays dark until its own `cdk deploy Sps-App-<env>`, because
 * CD ships a new image without registering a new task definition. This reads
 * the value the process actually has, so an operator can compare it against
 * the per-env block in `cdk/lib/app-stack.ts` without AWS access.
 *
 * Reads ONLY the names in the generated `FLAG_INVENTORY` allowlist. It never
 * iterates `process.env`, so a secret or an infra value can't leak through.
 * An unset name reports `null`, which is what a merged-but-undeployed flag
 * looks like at runtime.
 */
import { FLAG_INVENTORY } from "./flag-inventory.generated";

export type EffectiveFlags = {
  buildSha: string | null;
  spsEnv: string | null;
  flags: Record<string, string | null>;
};

export function readEffectiveFlags(
  env: Record<string, string | undefined> = process.env,
): EffectiveFlags {
  const flags: Record<string, string | null> = {};
  for (const name of FLAG_INVENTORY) flags[name] = env[name] ?? null;  return {
    // The deploying commit SHA, passed as a build-arg by the Deploy workflow
    // (Dockerfile). Empty in local and CI builds.
    buildSha: env.NEXT_DEPLOYMENT_ID || null,
    spsEnv: env.SPS_ENV ?? null,
    flags,
  };
}
