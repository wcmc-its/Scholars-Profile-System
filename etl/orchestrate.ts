/**
 * Phase 4g: Daily ETL orchestrator. Per Q5':
 *   - ED runs first (chain head). Failure ABORTS the rest of the chain.
 *   - All other sources run independently after ED succeeds. Per-source
 *     failure does not stop sibling sources.
 *   - Search reindex runs last, after all source ETLs.
 *
 * In production this lives behind EventBridge / Step Functions. For the
 * prototype: `npm run etl:daily` runs the chain in-process.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRevalidate } from "./revalidate";

type StepResult = { source: string; ok: boolean; durationMs: number; error?: string };

function runScript(file: string): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const repo = path.resolve(fileURLToPath(import.meta.url), "../..");
    const child = spawn(
      "node",
      ["--import", "tsx/esm", path.join(repo, file)],
      { stdio: "inherit", env: process.env, cwd: repo },
    );
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        durationMs: Date.now() - start,
        error: code === 0 ? undefined : `exit ${code}`,
      });
    });
    child.on("error", (err) => {
      resolve({ ok: false, durationMs: Date.now() - start, error: err.message });
    });
  });
}

async function step(source: string, file: string): Promise<StepResult> {
  console.log(`\n=== ${source} ===`);
  const r = await runScript(file);
  console.log(`[${source}] ${r.ok ? "OK" : "FAIL"} in ${(r.durationMs / 1000).toFixed(1)}s`);
  return { source, ...r };
}

async function main() {
  const overall = Date.now();
  const results: StepResult[] = [];

  // 1. ED — chain head; abort cascade on failure
  const ed = await step("ED", "etl/ed/index.ts");
  results.push(ed);
  if (!ed.ok) {
    console.error("\nED ETL failed. Aborting downstream ETLs (Q5' chain-head abort).");
    summarize(results, overall);
    process.exit(1);
  }

  // 2. Other sources run sequentially. Failures are isolated — a failed
  //    source does not block the rest. (Could be parallel; sequential keeps
  //    output legible during prototype runs.)
  for (const [source, file] of [
    ["ReCiter", "etl/reciter/index.ts"],
    // PubMed competing-interest statements (#`SELF_EDIT_COI_GAP_HINT` source).
    // Same WCM-ReciterDB path as ReCiter (reads reporting_conflicts), so it runs
    // right after it; no-op-safe — the backfill warns loudly on 0 rows rather
    // than failing, so it is safe in the chain on the same footing as ReCiter
    // even before #443 lands.
    ["ReCiter-COI-Statements", "etl/reciter/backfill-coi-statements.ts"],
    ["ASMS", "etl/asms/index.ts"],
    ["InfoEd", "etl/infoed/index.ts"],
    ["Jenzabar", "etl/jenzabar/index.ts"],
    ["ED-Student-Programs", "etl/ed/student-programs.ts"],
    // #728 — ED admin-role org-unit managers. Runs after ED (which populates the
    // Department/Division rows this resolves against). Writes gated behind
    // SELF_EDIT_ED_ADMINS_IMPORT=on; dry-run + fail-closed otherwise, so it is
    // safe in the chain even before #443 LDAP routing lands. (Deployed Step
    // Function nightly wiring is held pending OQ-4.)
    ["ED-Admins", "etl/ed-admins/index.ts"],
    ["RePORTER", "etl/reporter/index.ts"],
    ["NSF", "etl/nsf/index.ts"],
    ["Gates", "etl/gates/index.ts"],
    ["NIH-Profile", "etl/nih-profile/index.ts"],
    ["COI", "etl/coi/index.ts"],
    // COI-gap recommendations. Runs after both its inputs: the disclosed COI
    // (etl:coi, just above) and the PubMed statements (etl:reciter:coi-statements).
    // Reads SPS-DB only — not WCM-network-blocked — so it computes whatever its
    // inputs hold (zero candidates when statements haven't been ingested yet).
    ["COI-Gap", "etl/coi-gap/index.ts"],
    ["Hierarchy", "etl/hierarchy/index.ts"],
    ["Spotlight", "etl/spotlight/index.ts"],
    ["DynamoDB", "etl/dynamodb/index.ts"],
    // #794 — A2 canonical tools taxonomy → scholar_tool. Runs AFTER DynamoDB
    // (whose FACULTY#/scholar projection the cwid FK targets) and is the sole
    // scholar_tool writer when SCHOLAR_TOOL_SOURCE=s3; a no-op in ddb mode.
    ["Tools", "etl/tools/index.ts"],
    // Spec §1.7 — runs after ReCiter so the publication.mesh_terms numerator
    // is fresh. No-op-safe: if ReCiter failed earlier this still updates
    // against the prior snapshot, which is at worst stale by one cycle.
    ["MeshCoverage", "etl/mesh-coverage/index.ts"],
  ] as const) {
    results.push(await step(source, file));
  }

  // 3. Search reindex — runs unconditionally; if a source ETL failed the
  //    index is rebuilt against whatever did succeed.
  results.push(await step("OpenSearch", "etl/search-index/index.ts"));

  // Phase 6 ANALYTICS-03 / Pitfall 3 — completeness snapshot is best-effort.
  // It runs after the OpenSearch reindex so the publication graph is fresh,
  // but its failure NEVER affects the chain's exit code. The result is not
  // appended to `results` so the `process.exit(results.some(r => !r.ok) ? 1 : 0)`
  // logic at the bottom of `main` ignores completeness outcomes entirely.
  try {
    const completeness = await step("Completeness", "etl/completeness/index.ts");
    if (!completeness.ok) {
      console.warn(
        "[Completeness] snapshot step failed (non-fatal):",
        completeness.error,
      );
    }
  } catch (err) {
    console.warn("[Completeness] snapshot step threw (non-fatal):", err);
  }

  // 4. ISR cache invalidation. Per ADR-008: profile, home, and topic pages are
  //    rendered with `export const revalidate` time-based ISR; on-demand
  //    revalidation is what actually keeps the cache fresh after an ETL run.
  //    The sweep lives in `etl/revalidate/index.ts` so each cadence Step
  //    Function can invoke it as a standalone closing step (#479) — the daily
  //    orchestrator just delegates to the same module here, preserving the
  //    inline behavior.
  //
  //    Failures are logged via console.warn but do NOT fail the ETL run —
  //    the 6h ISR TTL ensures the cache eventually refreshes even if the
  //    revalidate endpoint is unreachable.
  await runRevalidate();

  summarize(results, overall);
  if (results.some((r) => !r.ok)) process.exit(1);
}

function summarize(results: StepResult[], overall: number) {
  console.log("\n=== Summary ===");
  for (const r of results) {
    const status = r.ok ? "✓" : "✗";
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    console.log(`  ${status} ${r.source.padEnd(12)} ${dur}${r.error ? "  (" + r.error + ")" : ""}`);
  }
  console.log(`Total: ${((Date.now() - overall) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
