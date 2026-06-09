/**
 * Tools ETL — #794. A2 canonical tools/methods taxonomy (v7) → `scholar_tool`.
 *
 * Repoints the `scholar_tool` table from the legacy ReciterAI `TOOL#` DynamoDB
 * scan (etl/dynamodb Block 5 — slug-mangled, no canonical dedup, no method
 * families) to the canonical A2 artifact published at
 * s3://wcmc-reciterai-artifacts/tools/. This fixes the `C57BL_6` → `C57BL/6`
 * slug-mangling (#765 item 1) for free and adds method-family categories +
 * salience-tier ranking.
 *
 * Behavior-preserving: the only `scholar_tool` reader (lib/edit/overview-facts.ts)
 * reads toolName / category / pmidCount / maxConfidence ordered by
 * [pmidCount desc, maxConfidence desc]; this loader writes exactly that shape.
 * The field-by-field source mapping lives in ./scholar-tool-mapper-s3.ts.
 *
 * Cutover is reversible behind `SCHOLAR_TOOL_SOURCE` (lib/etl/scholar-tool-source.ts):
 *   - `ddb` (default): the legacy Block 5 owns `scholar_tool`; this loader is a
 *     no-op (records a 0-row success so freshness stays green) UNLESS run with
 *     `--dry-run`, which always loads + maps + diffs without writing.
 *   - `s3`: this loader is the SOLE writer (Block 5 skips); full-replacement.
 *
 * S3 contract (ReciterAI#173): `<prefix>/latest/manifest.json` is the source of
 * truth — { schema_version, version, sha256, artifact_bytes, objects{ file →
 * {key, bytes, sha256} }, counts }. `tools.json` is a superset that embeds the
 * canonical `tools[]` AND the per-faculty `faculty{}` rollup (byte-identical to
 * the standalone faculty.json), so one atomic fetch avoids cross-file skew.
 *
 * Env:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION  (default us-east-1)
 *   TOOLS_BUCKET   (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   TOOLS_PREFIX   (default tools)
 *   SCHOLAR_TOOL_SOURCE  (ddb default | s3)
 *   SCHOLAR_TOOL_DRY_RUN (any value, or pass --dry-run) — load + diff, no write
 *
 * Usage:
 *   npm run etl:scholar-tool
 *   tsx etl/tools/index.ts --dry-run
 */
import { createHash } from "node:crypto";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "../../lib/db";
import { resolveScholarToolSource } from "../../lib/etl/scholar-tool-source";
import {
  buildScholarToolWritesFromS3,
  type ToolsArtifactSlice,
} from "./scholar-tool-mapper-s3";

// ---------------------------------------------------------------------------
// Module-level env constants — AWS SDK default credential chain; never hardcode
// keys here. The bucket is the shared ReciterAI artifacts bucket; the tools
// artifact lives under the `tools/` prefix (sibling to spotlight/, hierarchy).
// ---------------------------------------------------------------------------
const BUCKET =
  process.env.TOOLS_BUCKET ?? process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts";
const PREFIX = process.env.TOOLS_PREFIX ?? "tools";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const SOURCE = "Tools"; // etl_run.source — registered nightly in etl/freshness

const dryRun =
  process.argv.includes("--dry-run") || Boolean(process.env.SCHOLAR_TOOL_DRY_RUN);

// ---------------------------------------------------------------------------
// Artifact / manifest types — mirror the A2 tools-a2-v1 manifest (ReciterAI#173).
// ---------------------------------------------------------------------------

interface ManifestObject {
  key: string;
  bytes: number;
  sha256: string;
}

interface ToolsManifest {
  schema_version: string; // e.g. "tools-a2-v1"
  version: string; // publish version, e.g. "v2026-06-09"
  generated_at: string;
  sha256: string; // sha256 of the primary artifact (tools.json) bytes
  artifact_bytes: number;
  objects: Record<string, ManifestObject>; // "tools.json" | "faculty.json" | "families.json"
  counts?: { tools?: number; families?: number; faculty?: number };
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(`[Tools] ${JSON.stringify({ event, ts: Date.now(), ...fields })}`);
}

// ---------------------------------------------------------------------------
// S3 helpers
// ---------------------------------------------------------------------------

async function fetchBytes(s3: S3Client, key: string): Promise<Uint8Array> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return resp.Body!.transformToByteArray();
}

async function fetchText(s3: S3Client, key: string): Promise<string> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return resp.Body!.transformToString("utf-8");
}

function sha256hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// EtlRun helper — same pattern as etl/spotlight/index.ts. `manifestTaxonomyVersion`
// is a shared free-text column; for Tools (no taxonomy concept) we store the
// artifact publish version there for readable operator diagnostics.
// ---------------------------------------------------------------------------

async function recordRun(args: {
  status: "success" | "failed";
  rowsProcessed: number;
  manifest?: ToolsManifest;
  errorMessage?: string;
}): Promise<void> {
  await db.write.etlRun.create({
    data: {
      source: SOURCE,
      status: args.status,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
      manifestSha256: args.manifest?.sha256 ?? null,
      manifestTaxonomyVersion: args.manifest?.version ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Dry-run diff — load + map (no write), then compare against the live table for
// a sample of scholars: tool-set overlap, top-10 overlap, and the two ordered
// top-10 lists. The #794 staging verification artifact (parallel-run vs Block 5).
// ---------------------------------------------------------------------------

async function printDryRunDiff(
  writes: ReturnType<typeof buildScholarToolWritesFromS3>["writes"],
): Promise<void> {
  const byCwid = new Map<string, string[]>(); // cwid → tool names, rank order preserved
  for (const w of writes) {
    const list = byCwid.get(w.cwid) ?? [];
    list.push(w.toolName);
    byCwid.set(w.cwid, list);
  }

  const sample = [...byCwid.keys()].slice(0, 5);
  log("dry_run_sample", { sampled_cwids: sample.length, scholars_with_rows: byCwid.size });

  for (const cwid of sample) {
    const next = byCwid.get(cwid) ?? [];
    const current = await db.read.scholarTool.findMany({
      where: { cwid },
      orderBy: [{ pmidCount: "desc" }, { maxConfidence: "desc" }],
      select: { toolName: true },
    });
    const curNames = current.map((r) => r.toolName);
    const curSet = new Set(curNames);
    const nextSet = new Set(next);
    const intersection = [...nextSet].filter((n) => curSet.has(n)).length;
    const union = new Set([...curSet, ...nextSet]).size;
    const top10Cur = new Set(curNames.slice(0, 10));
    const top10Next = next.slice(0, 10);
    const top10Overlap = top10Next.filter((n) => top10Cur.has(n)).length;
    log("dry_run_diff", {
      cwid,
      current_tools: curNames.length,
      new_tools: next.length,
      set_overlap: union ? Number((intersection / union).toFixed(3)) : null,
      top10_overlap: top10Overlap,
      current_top10: curNames.slice(0, 10),
      new_top10: top10Next,
    });
  }
}

// ---------------------------------------------------------------------------
// Main ETL flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const source = resolveScholarToolSource();

  // ddb mode (default): the legacy Block 5 owns scholar_tool. Record a 0-row
  // success so the nightly "Tools" freshness check stays green, and exit
  // WITHOUT touching S3 — keeping a broken artifact/grant from false-alarming
  // the nightly while ddb still owns the table. `--dry-run` overrides this to
  // exercise the full S3 path for staging verification.
  if (!dryRun && source !== "s3") {
    log("skipped", {
      reason: "SCHOLAR_TOOL_SOURCE != s3; scholar_tool owned by etl:dynamodb Block 5",
      source,
    });
    await recordRun({ status: "success", rowsProcessed: 0 });
    return;
  }

  const s3 = new S3Client({ region: REGION });

  // Step 1: manifest (source of truth).
  const manifest: ToolsManifest = JSON.parse(
    await fetchText(s3, `${PREFIX}/latest/manifest.json`),
  );
  log("manifest_fetched", {
    schema_version: manifest.schema_version,
    version: manifest.version,
    sha256_prefix: manifest.sha256.slice(0, 12),
    artifact_bytes: manifest.artifact_bytes,
    counts: manifest.counts,
    dry_run: dryRun,
    source,
  });

  // Step 2: sha256 short-circuit — skip an unchanged artifact (write path only).
  if (!dryRun) {
    const lastRun = await db.write.etlRun.findFirst({
      where: { source: SOURCE, status: "success" },
      orderBy: { completedAt: "desc" },
    });
    if (lastRun?.manifestSha256 === manifest.sha256) {
      log("short_circuit", { sha256: manifest.sha256, version: manifest.version, rows: 0 });
      await recordRun({ status: "success", rowsProcessed: 0, manifest });
      return;
    }
  }

  // Step 3: fetch the primary artifact by its manifest key, verify integrity.
  // tools.json embeds both the canonical tools[] and the faculty{} rollup.
  const toolsObj = manifest.objects?.["tools.json"];
  if (!toolsObj?.key) {
    throw new Error("manifest.objects['tools.json'].key missing");
  }
  const bytes = await fetchBytes(s3, toolsObj.key);
  const digest = sha256hex(bytes);
  const expected = toolsObj.sha256;
  if (expected && digest !== expected) {
    log("integrity_failed", {
      key: toolsObj.key,
      expected_sha256: expected,
      actual_sha256: digest,
      bytes: bytes.byteLength,
    });
    await recordRun({
      status: "failed",
      rowsProcessed: 0,
      manifest,
      errorMessage: `sha256 mismatch on ${toolsObj.key}: expected ${expected}, got ${digest}`,
    });
    process.exit(1);
  }

  const parsed = JSON.parse(Buffer.from(bytes).toString("utf-8")) as {
    tools?: unknown;
    faculty?: unknown;
  };
  if (!Array.isArray(parsed.tools) || !parsed.faculty || typeof parsed.faculty !== "object") {
    throw new Error("tools.json missing tools[] array or faculty{} object");
  }
  const artifact: ToolsArtifactSlice = {
    tools: parsed.tools as ToolsArtifactSlice["tools"],
    faculty: parsed.faculty as ToolsArtifactSlice["faculty"],
  };
  log("artifact_loaded", {
    tools: artifact.tools.length,
    faculty: Object.keys(artifact.faculty).length,
    integrity_ok: true,
  });

  // Step 4: FK scope — active in-scope scholars, same filter as the other ETL
  // projections (scholar_tool.cwid → scholar.cwid). Out-of-scope cwids in the
  // artifact are silently skipped (counted) rather than erroring the run.
  const ourScholars = await db.write.scholar.findMany({
    where: { deletedAt: null, status: "active" },
    select: { cwid: true },
  });
  const ourCwidSet = new Set(ourScholars.map((s) => s.cwid));

  // Step 5: map.
  const result = buildScholarToolWritesFromS3(artifact, { ourCwidSet });
  log("mapped", {
    rows: result.writes.length,
    skipped_out_of_scope_cwid: result.skippedMissingCwid,
    skipped_missing_fields: result.skippedMissingFields,
    unknown_tool_fallback: result.unknownToolFallback,
  });

  // Dry-run: diff against the live table and stop — never write, never record.
  if (dryRun) {
    await printDryRunDiff(result.writes);
    log("dry_run_complete", { rows_would_write: result.writes.length });
    return;
  }

  // Step 6: full-replacement write — deleteMany then chunked createMany, the
  // same semantics Block 5 used (identity is @@unique([cwid, toolName]); the
  // uuid id is unstable across runs so this is a rebuild, not an upsert).
  log("writing", { rows: result.writes.length });
  await db.write.scholarTool.deleteMany();

  let inserted = 0;
  const TOOL_BATCH = 500;
  for (let i = 0; i < result.writes.length; i += TOOL_BATCH) {
    const chunk = result.writes.slice(i, i + TOOL_BATCH);
    await db.write.scholarTool.createMany({
      data: chunk.map((w) => ({
        cwid: w.cwid,
        toolName: w.toolName,
        category: w.category,
        pmidCount: w.pmidCount,
        maxConfidence: new Prisma.Decimal(w.maxConfidence),
        sampleContext: w.sampleContext,
        pmids: w.pmids,
      })),
      skipDuplicates: true,
    });
    inserted += chunk.length;
  }

  log("write_complete", {
    rows: inserted,
    version: manifest.version,
    sha256_prefix: manifest.sha256.slice(0, 12),
  });
  await recordRun({ status: "success", rowsProcessed: inserted, manifest });
}

main()
  .catch(async (err) => {
    log("etl_failed", { error: String(err?.message ?? err) });
    try {
      // Dry-run must never write an etl_run row (it is a diagnostic, not a run).
      if (!dryRun) {
        await recordRun({
          status: "failed",
          rowsProcessed: 0,
          errorMessage: String(err?.message ?? err),
        });
      }
    } catch (recordErr) {
      console.error("[Tools] could not record failed EtlRun:", recordErr);
    }
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
    await db.read.$disconnect();
  });
