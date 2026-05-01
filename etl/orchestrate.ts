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
import { prisma } from "@/lib/db";

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

  // 4. ISR cache invalidation. Per ADR-008: profile, home, and topic pages are
  //    rendered with `export const revalidate` time-based ISR; on-demand
  //    revalidation is what actually keeps the cache fresh after an ETL run.
  //    Phase 2 Plan 09 wires the home page + all topic pages here. Per-scholar
  //    `/scholars/{slug}` revalidations are emitted by the source-system ETLs
  //    that touch individual scholar records (not blanket here, since 8,943
  //    profiles × per-CWID HTTP call is wasteful when most are unchanged).
  //
  //    Failures are logged via console.warn but do NOT fail the ETL run —
  //    the 6h ISR TTL ensures the cache eventually refreshes even if the
  //    revalidate endpoint is unreachable. Phase 6 adds an alert if the
  //    stale-cache rate exceeds threshold.
  console.log("\n=== Revalidate ISR caches ===");
  await revalidatePath("/");
  try {
    const topics = await prisma.topic.findMany({ select: { id: true } });
    for (const t of topics) {
      await revalidatePath(`/topics/${t.id}`);
    }
    console.log(`[Revalidate] queued / + ${topics.length} topic page(s)`);
  } catch (err) {
    console.warn("[Revalidate] could not enumerate topics:", err);
  } finally {
    await prisma.$disconnect();
  }

  summarize(results, overall);
  if (results.some((r) => !r.ok)) process.exit(1);
}

/**
 * POST /api/revalidate?path={p} with the shared SCHOLARS_REVALIDATE_TOKEN
 * header. Best-effort: failures are warned, never thrown — see ADR-008 ISR
 * fallback. Token is the only auth barrier per Plan 09 threat register
 * (T-02-09-01); base URL defaults to localhost for the prototype but is
 * overridable via SCHOLARS_BASE_URL for AWS deployment.
 */
async function revalidatePath(p: string): Promise<void> {
  const token = process.env.SCHOLARS_REVALIDATE_TOKEN;
  const baseUrl = process.env.SCHOLARS_BASE_URL ?? "http://localhost:3000";
  if (!token) {
    console.warn(`[Revalidate] SCHOLARS_REVALIDATE_TOKEN unset; skipping ${p}`);
    return;
  }
  try {
    const resp = await fetch(`${baseUrl}/api/revalidate?path=${encodeURIComponent(p)}`, {
      method: "POST",
      headers: { "x-revalidate-token": token },
    });
    if (!resp.ok) {
      console.warn(`[Revalidate] ${p} → ${resp.status} ${resp.statusText}`);
    }
  } catch (err) {
    console.warn(`[Revalidate] ${p} threw:`, err);
  }
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
