/**
 * Weekly ReciterDB bridge refresh (#3348): export the mentoring co-pub and
 * cited-by products from ReciterDB to S3, then import them into this env's
 * bridge tables. Runs as `MentoringBridgeWeekly` on the sources task family
 * (cdk/lib/etl-stack.ts), which holds the ReciterDB credentials.
 *
 * Every S3 key is scoped by SCHOLARS_ENV: export-copubs also reads this env's
 * own DB (PhD/postdoc mentor pairs), so staging and prod outputs differ and
 * must never overwrite each other. Refuses to run without SCHOLARS_ENV.
 *
 * Runs every step and exits 1 if any failed. A failed export leaves last
 * week's object in place; its import then reloads that object (idempotent,
 * and the importers refuse an empty parse), so partial failure never wipes.
 *
 * Usage: SCHOLARS_ENV=<env> npm run etl:mentoring:refresh
 */
import { spawnSync } from "node:child_process";

export const BRIDGE_STEPS = [
  "etl:mentoring:export-copubs",
  "etl:mentoring:export-citing",
  "etl:mentoring:import-copubs",
  "etl:mentoring:import-aoc",
  "etl:mentoring:import-copub-list",
  "etl:mentoring:import-learner-pubs",
  "etl:mentoring:import-citing",
] as const;

/** The key env vars every export/import script already honors, scoped per env. */
export function bridgeKeys(env: string): Record<string, string> {
  if (!/^[a-z0-9-]+$/.test(env)) throw new Error(`refusing unsafe SCHOLARS_ENV for an S3 key: ${env}`);
  return {
    MENTORING_COPUBS_KEY: `mentoring/${env}/copubs.ndjson`,
    MENTORING_AOC_KEY: `mentoring/${env}/aoc-mentees.ndjson`,
    MENTORING_COPUB_LIST_KEY: `mentoring/${env}/copub-list.ndjson`,
    MENTORING_LEARNER_PUBS_KEY: `mentoring/${env}/learner-pubs.ndjson`,
    PUBLICATION_CITING_KEY: `citations/${env}/citing.ndjson`,
  };
}

function main(): void {
  const env = process.env.SCHOLARS_ENV;
  if (!env) throw new Error("SCHOLARS_ENV is not set; it scopes the bridge S3 keys per env");
  const childEnv = { ...process.env, ...bridgeKeys(env) };
  const failed: string[] = [];
  for (const step of BRIDGE_STEPS) {
    console.log(`[mentoring-refresh] ${step}`);
    const r = spawnSync("npm", ["run", step], { stdio: "inherit", env: childEnv });
    if (r.status !== 0) failed.push(step);
  }
  if (failed.length > 0) {
    console.error(`[mentoring-refresh] failed: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log("[mentoring-refresh] all steps succeeded");
}

if (!process.env.VITEST) main();
