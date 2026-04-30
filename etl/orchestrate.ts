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

type StepResult = { source: string; ok: boolean; durationMs: number; error?: string };

function runScript(file: string): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const repo = path.resolve(__dirname, "..");
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
    ["ASMS", "etl/asms/index.ts"],
    ["InfoEd", "etl/infoed/index.ts"],
    ["COI", "etl/coi/index.ts"],
    ["DynamoDB", "etl/dynamodb/index.ts"],
  ] as const) {
    results.push(await step(source, file));
  }

  // 3. Search reindex — runs unconditionally; if a source ETL failed the
  //    index is rebuilt against whatever did succeed.
  results.push(await step("OpenSearch", "etl/search-index/index.ts"));

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
