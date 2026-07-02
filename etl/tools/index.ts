/**
 * Tools ETL — #794 / #799. A2 canonical tools/methods taxonomy → `scholar_tool`
 * (per-tool rollup, #794) AND `scholar_family` (per-method-family rollup, #799,
 * the family-primary Methods lens). Both are written from the SAME `tools.json`
 * fetch so the two rollups can never skew, under the same `SCHOLAR_TOOL_SOURCE`
 * gate. The family mapping lives in ./scholar-family-mapper-s3.ts.
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
 *   SCHOLAR_TOOL_FORCE_REPLACE (set to "1", or pass --force) — bypass the
 *     sha256 short-circuit and always full-replace (operator escape hatch,
 *     mirrors MESH_FORCE_REPLACE in etl/mesh-descriptors)
 *
 * Usage:
 *   npm run etl:scholar-tool
 *   tsx etl/tools/index.ts --dry-run
 *   tsx etl/tools/index.ts --force      # bypass short-circuit, force a rewrite
 */
import { createHash } from "node:crypto";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "../../lib/db";
import { assertSourceVolume } from "../../lib/etl-guard";
import { loadAllPublicationSuppressions } from "@/lib/api/manual-layer";
import { resolveScholarToolSource } from "../../lib/etl/scholar-tool-source";
import { buildScholarToolWritesFromS3, type ToolsArtifactSlice } from "./scholar-tool-mapper-s3";
import {
  buildScholarFamilyWritesFromS3,
  type ScholarFamilyWrite,
} from "./scholar-family-mapper-s3";
import { buildToolContextIndex, type ToolContextIndex } from "./tool-context";
import {
  buildFamilyEntityWritesFromS3,
  type FamilyEntityArtifact,
} from "./family-entity-mapper-s3";
import { manifestContentSignature } from "./manifest-signature";

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

const dryRun = process.argv.includes("--dry-run") || Boolean(process.env.SCHOLAR_TOOL_DRY_RUN);
const forceReplace =
  process.argv.includes("--force") || process.env.SCHOLAR_TOOL_FORCE_REPLACE === "1";

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
  // "tools.json" | "faculty.json" | "families.json" | "tool_context.json" (#1119)
  // | "entities.json" | "entity_context.json" (#1166)
  objects: Record<string, ManifestObject>;
  counts?: {
    tools?: number;
    families?: number;
    faculty?: number;
    tool_context?: number;
    entities?: number;
    entity_context?: number;
  };
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
      // Store the composite signature (all object shas), not just tools.json's
      // top-level sha — so the next run's short-circuit detects a single-object
      // republish (e.g. tool_context.json only, ReciterAI#238). Compared, never
      // displayed; readable provenance stays in manifestTaxonomyVersion.
      manifestSha256: args.manifest ? manifestContentSignature(args.manifest) : null,
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
// Dry-run family preview — the staging verification artifact for #799: how many
// families would write, and the top families for a small sample of scholars.
// ---------------------------------------------------------------------------

function printFamilyDryRun(writes: ScholarFamilyWrite[]): void {
  const byCwid = new Map<string, ScholarFamilyWrite[]>(); // cwid → families, rank order preserved
  for (const w of writes) {
    const list = byCwid.get(w.cwid) ?? [];
    list.push(w);
    byCwid.set(w.cwid, list);
  }
  const sample = [...byCwid.keys()].slice(0, 5);
  log("dry_run_family_sample", {
    scholars_with_families: byCwid.size,
    sampled_cwids: sample.length,
  });
  for (const cwid of sample) {
    const fams = byCwid.get(cwid) ?? [];
    log("dry_run_family_top", {
      cwid,
      families: fams.length,
      top10: fams.slice(0, 10).map((f) => ({
        label: f.familyLabel,
        supercategory: f.supercategory,
        pmid_count: f.pmidCount,
        // #1119 — how many exemplar tools resolved a usage snippet, and one sample.
        exemplar_contexts: Object.keys(f.exemplarContexts).length,
        sample_context: Object.values(f.exemplarContexts)[0] ?? null,
      })),
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
  const manifest: ToolsManifest = JSON.parse(await fetchText(s3, `${PREFIX}/latest/manifest.json`));
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
  // Compare against the COMPOSITE signature over every manifest object's sha,
  // not just tools.json's top-level sha, so a tool_context.json-only republish
  // (ReciterAI#238) is NOT masked by an unchanged primary artifact. `--force` /
  // SCHOLAR_TOOL_FORCE_REPLACE bypasses it entirely (operator escape hatch).
  if (!dryRun && !forceReplace) {
    const signature = manifestContentSignature(manifest);
    const lastRun = await db.write.etlRun.findFirst({
      where: { source: SOURCE, status: "success" },
      orderBy: { completedAt: "desc" },
    });
    if (lastRun?.manifestSha256 === signature) {
      log("short_circuit", {
        sha256: manifest.sha256,
        signature_prefix: signature.slice(0, 12),
        version: manifest.version,
        rows: 0,
      });
      await recordRun({ status: "success", rowsProcessed: 0, manifest });
      return;
    }
  }
  if (forceReplace) {
    log("force_replace", {
      reason: "SCHOLAR_TOOL_FORCE_REPLACE/--force",
      version: manifest.version,
    });
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
    families?: unknown;
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

  // #879 — index the TOP-LEVEL `families[]` taxonomy by family_id → generated
  // definition. The per-scholar `faculty[].families[]` slice carries no definition,
  // so the family mapper joins it in by family_id. Additive/optional: a pre-v3
  // artifact (or a family with no generated gloss) yields null, never an error.
  const familyDefById = new Map<
    string,
    { definition: string | null; definitionSource: string | null }
  >();
  for (const raw of Array.isArray(parsed.families) ? parsed.families : []) {
    const f = raw as { family_id?: unknown; definition?: unknown; definition_source?: unknown };
    const id = typeof f?.family_id === "string" ? f.family_id.trim() : "";
    if (!id) continue;
    const definition =
      typeof f?.definition === "string" && f.definition.trim() ? f.definition.trim() : null;
    const definitionSource =
      typeof f?.definition_source === "string" && f.definition_source.trim()
        ? f.definition_source.trim()
        : null;
    familyDefById.set(id, { definition, definitionSource });
  }
  log("family_definitions_indexed", {
    families: familyDefById.size,
    with_definition: [...familyDefById.values()].filter((v) => v.definition !== null).length,
  });

  // #1119 — tool-context: the sibling `tool_context.json` object maps each tool to
  // a per-publication usage sentence (tool_id → pmid → snippet). OPTIONAL: a
  // pre-v3 manifest omits the object, which leaves sampleContext/exemplarContexts
  // null/{} (benign). When PRESENT it is sha256-verified like the primary artifact
  // — a mismatch fails the run rather than writing partially-grounded context.
  let toolContext: ToolContextIndex = buildToolContextIndex(null);
  const ctxObj = manifest.objects?.["tool_context.json"];
  if (!ctxObj?.key) {
    log("tool_context_absent", { reason: "manifest has no tool_context.json object" });
  } else {
    const ctxBytes = await fetchBytes(s3, ctxObj.key);
    const ctxDigest = sha256hex(ctxBytes);
    if (ctxObj.sha256 && ctxDigest !== ctxObj.sha256) {
      log("integrity_failed", {
        key: ctxObj.key,
        expected_sha256: ctxObj.sha256,
        actual_sha256: ctxDigest,
        bytes: ctxBytes.byteLength,
      });
      await recordRun({
        status: "failed",
        rowsProcessed: 0,
        manifest,
        errorMessage: `sha256 mismatch on ${ctxObj.key}: expected ${ctxObj.sha256}, got ${ctxDigest}`,
      });
      process.exit(1);
    }
    const ctxParsed = JSON.parse(Buffer.from(ctxBytes).toString("utf-8")) as {
      tool_context?: unknown;
      tool_context_kind?: unknown;
    };
    toolContext = buildToolContextIndex(ctxParsed.tool_context);
    log("tool_context_loaded", {
      kind: typeof ctxParsed.tool_context_kind === "string" ? ctxParsed.tool_context_kind : null,
      tools_with_context: toolContext.stats.toolsWithContext,
      tools_with_usable_snippet: toolContext.stats.toolsWithUsable,
      raw_snippets: toolContext.stats.rawSnippets,
      dropped_junk: toolContext.stats.droppedJunk,
      integrity_ok: true,
    });
  }

  // #1166 — specific-entity layer (Methods Surface B). The sibling `entities.json`
  // (the entity DIMENSION) + `entity_context.json` (the per-(pub × entity) FACTS)
  // sidecars (tools-a2-v4). OPTIONAL + paired: a pre-v4 manifest (or a manifest
  // missing either object) leaves the family_entity* tables untouched this run
  // (benign). When present each is sha256-verified like the primary artifact —
  // a mismatch fails the run rather than writing partial entity data.
  let entityArtifact: FamilyEntityArtifact = { entities: [], entityContext: {} };
  const entitiesObj = manifest.objects?.["entities.json"];
  const entityCtxObj = manifest.objects?.["entity_context.json"];
  if (!entitiesObj?.key || !entityCtxObj?.key) {
    log("entity_layer_absent", {
      reason: "manifest has no entities.json / entity_context.json object",
      has_entities: Boolean(entitiesObj?.key),
      has_entity_context: Boolean(entityCtxObj?.key),
    });
  } else {
    const entBytes = await fetchBytes(s3, entitiesObj.key);
    const ctxBytes = await fetchBytes(s3, entityCtxObj.key);
    for (const [obj, b] of [
      [entitiesObj, entBytes],
      [entityCtxObj, ctxBytes],
    ] as const) {
      const d = sha256hex(b);
      if (obj.sha256 && d !== obj.sha256) {
        log("integrity_failed", {
          key: obj.key,
          expected_sha256: obj.sha256,
          actual_sha256: d,
          bytes: b.byteLength,
        });
        await recordRun({
          status: "failed",
          rowsProcessed: 0,
          manifest,
          errorMessage: `sha256 mismatch on ${obj.key}: expected ${obj.sha256}, got ${d}`,
        });
        process.exit(1);
      }
    }
    const entParsed = JSON.parse(Buffer.from(entBytes).toString("utf-8")) as { entities?: unknown };
    const ctxParsed = JSON.parse(Buffer.from(ctxBytes).toString("utf-8")) as {
      entity_context?: unknown;
    };
    entityArtifact = {
      entities: Array.isArray(entParsed.entities)
        ? (entParsed.entities as FamilyEntityArtifact["entities"])
        : [],
      entityContext:
        ctxParsed.entity_context && typeof ctxParsed.entity_context === "object"
          ? (ctxParsed.entity_context as FamilyEntityArtifact["entityContext"])
          : {},
    };
    log("entity_layer_loaded", {
      entities: entityArtifact.entities.length,
      entity_context_entities: Object.keys(entityArtifact.entityContext).length,
      integrity_ok: true,
    });
  }

  // Step 4: FK scope — active in-scope scholars, same filter as the other ETL
  // projections (scholar_tool.cwid → scholar.cwid). Out-of-scope cwids in the
  // artifact are silently skipped (counted) rather than erroring the run.
  const ourScholars = await db.write.scholar.findMany({
    where: { deletedAt: null, status: "active" },
    select: { cwid: true },
  });
  const ourCwidSet = new Set(ourScholars.map((s) => s.cwid));

  // #1119 ADR-005 — load active publication suppressions once so the mappers never
  // select a usage snippet sourced from a suppressed (dark or per-author-hidden)
  // paper. ETL-cadence is the correct freshness model: the whole methods-lens
  // projection refreshes on this run, not at render time.
  const suppression = await loadAllPublicationSuppressions(db.read);
  log("loaded_suppressions", {
    dark_pmids: suppression.darkPmids.size,
    pmids_with_hidden_authors: suppression.hiddenAuthorsByPmid.size,
  });

  // Step 5: map.
  const result = buildScholarToolWritesFromS3(artifact, { ourCwidSet, toolContext, suppression });
  log("mapped", {
    rows: result.writes.length,
    skipped_out_of_scope_cwid: result.skippedMissingCwid,
    skipped_missing_fields: result.skippedMissingFields,
    unknown_tool_fallback: result.unknownToolFallback,
    // #1119 — scholar_tool rows that got a non-null usage snippet from tool_context.
    with_sample_context: result.writes.filter((w) => w.sampleContext != null).length,
  });

  // scholar_family (#799) — mapped from the same artifact slice. Reuse the same
  // FK scope; the family rollup carries its own counters (see the mapper).
  const familyResult = buildScholarFamilyWritesFromS3(artifact, {
    ourCwidSet,
    familyDefById,
    toolContext,
    suppression,
  });
  log("mapped_families", {
    rows: familyResult.writes.length,
    skipped_out_of_scope_cwid: familyResult.skippedMissingCwid,
    skipped_missing_fields: familyResult.skippedMissingFields,
    unknown_supercategory: familyResult.unknownSupercategory,
    // #819 — rows whose distinct(pmids).length !== pub_count (ReciterAI#175
    // invariant). Should be 0; non-zero is a data-health alarm for the operator.
    pmid_count_mismatch: familyResult.pmidCountMismatch,
    // #879 — written rows that got a non-null definition from the join. Compare to
    // `with_definition` in the family_definitions_indexed log above: a near-zero
    // hit rate against a populated index signals a silent family_id join-key drift.
    definition_join_hits: familyResult.definitionJoinHits,
    // #989 — per-scholar families collapsed because two family_ids shared one
    // (supercategory, familyLabel). Should be 0; non-zero means the upstream
    // taxonomy emitted duplicate ids for a stable family — the mapper collapsed
    // them (so counts/chips stay correct) but the operator should reconcile A2.
    duplicate_family_label: familyResult.duplicateFamilyLabel,
    // #1119 — family rows with ≥1 exemplar-tool usage snippet, and the total
    // distinct exemplar snippets resolved. Compare the former to total family rows
    // for coverage; a near-zero count against a populated tool_context index hints
    // at an exemplar_tool_id ↔ tool_context tool_id key drift.
    families_with_exemplar_context: familyResult.writes.filter(
      (w) => Object.keys(w.exemplarContexts).length > 0,
    ).length,
  });

  // #1166 — entity DIMENSION + per-(pub × entity) FACTS from the same fetch. ADR-005
  // suppression drops dark-pmid facts; `evidenced` is recomputed against survivors.
  const entityResult = buildFamilyEntityWritesFromS3(entityArtifact, { suppression });
  log("mapped_entities", {
    entity_rows: entityResult.entityWrites.length,
    usage_rows: entityResult.usageWrites.length,
    evidenced_entities: entityResult.evidencedEntities,
    // ADR-005 facts dropped (a dark/taken-down paper's sentence). Expected small.
    suppressed_facts: entityResult.suppressedFacts,
    // Facts whose entity id had no DIMENSION record — a producer-side join alarm.
    orphan_facts: entityResult.orphanFacts,
    skipped_malformed_entities: entityResult.skippedMalformedEntities,
    // #1168 — WS-B generic-vocab count (soft-suppressed) + WS-C mention-class coverage.
    generic_entities: entityResult.genericEntities,
    mention_class_dist: entityResult.mentionClassDist,
  });

  // Dry-run: diff against the live table and stop — never write, never record.
  if (dryRun) {
    await printDryRunDiff(result.writes);
    printFamilyDryRun(familyResult.writes);
    log("dry_run_complete", {
      rows_would_write: result.writes.length,
      family_rows_would_write: familyResult.writes.length,
      entity_rows_would_write: entityResult.entityWrites.length,
      entity_usage_rows_would_write: entityResult.usageWrites.length,
    });
    return;
  }

  // Step 6: full-replacement write — deleteMany then chunked createMany, the
  // same semantics Block 5 used (identity is @@unique([cwid, toolName]); the
  // uuid id is unstable across runs so this is a rebuild, not an upsert).
  // A truncated/empty upstream artifact must not be mirrored as a wipe of the
  // Methods-lens tables (audit PR-3). Bootstrap (0 existing) passes.
  assertSourceVolume("tools:scholar-tool", {
    incoming: result.writes.length,
    existing: await db.write.scholarTool.count(),
    maxDropPct: 50,
  });
  log("writing", { rows: result.writes.length });
  // Delete + insert in one transaction so a mid-write kill can't leave
  // scholar_tool half-empty. Timeout raised above the 5 s default for the
  // batched createMany.
  let inserted = 0;
  const TOOL_BATCH = 500;
  await db.write.$transaction(
    async (tx) => {
      await tx.scholarTool.deleteMany();
      for (let i = 0; i < result.writes.length; i += TOOL_BATCH) {
        const chunk = result.writes.slice(i, i + TOOL_BATCH);
        await tx.scholarTool.createMany({
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
    },
    { timeout: 120_000, maxWait: 10_000 },
  );

  // scholar_family (#799) — same full-replacement semantics (deleteMany then
  // chunked createMany), written from the same artifact + the same gate. The
  // uuid id and family_id are both unstable across A2 rebuilds, so this is a
  // rebuild keyed by @@unique([cwid, family_id]); stamp the source artifact
  // sha256 on every row so a family-id renumber is detectable per refresh.
  assertSourceVolume("tools:scholar-family", {
    incoming: familyResult.writes.length,
    existing: await db.write.scholarFamily.count(),
    maxDropPct: 50,
  });
  // Delete + insert scholar_family AND the entity layer in one transaction so a
  // mid-write kill can't leave the Methods-lens projection half-rebuilt or skewed
  // between the family rollup and its entity detail. Timeout raised above the 5 s
  // default for the batched createMany.
  let familiesInserted = 0;
  const FAMILY_BATCH = 500;
  let entityRowsInserted = 0;
  let usageRowsInserted = 0;
  const ENTITY_BATCH = 1000;
  await db.write.$transaction(
    async (tx) => {
      await tx.scholarFamily.deleteMany();
      for (let i = 0; i < familyResult.writes.length; i += FAMILY_BATCH) {
        const chunk = familyResult.writes.slice(i, i + FAMILY_BATCH);
        await tx.scholarFamily.createMany({
          data: chunk.map((w) => ({
            cwid: w.cwid,
            familyId: w.familyId,
            familyLabel: w.familyLabel,
            supercategory: w.supercategory,
            pmidCount: w.pmidCount,
            exemplarTools: w.exemplarTools,
            exemplarContexts: w.exemplarContexts,
            exemplarContextPmids: w.exemplarContextPmids,
            pmids: w.pmids,
            definition: w.definition,
            definitionSource: w.definitionSource,
            sourceArtifactSha: manifest.sha256,
          })),
          skipDuplicates: true,
        });
        familiesInserted += chunk.length;
      }

      // #1166 — entity layer full-replacement (deleteMany then chunked createMany).
      // FACTS first then DIMENSION (no FK either way; order is cosmetic). Identity is
      // @@unique([supercategory, family_label, normalized_entity_id]) on the dimension;
      // the uuid id is unstable so this is a rebuild, not an upsert. Stamp the artifact
      // sha per row so a producer republish is detectable. An empty entityArtifact
      // (pre-v4 manifest) clears the tables — intentional: no entity data ⇒ no rows.
      await tx.familyEntityUsage.deleteMany();
      await tx.familyEntity.deleteMany();
      for (let i = 0; i < entityResult.entityWrites.length; i += ENTITY_BATCH) {
        const chunk = entityResult.entityWrites.slice(i, i + ENTITY_BATCH);
        await tx.familyEntity.createMany({
          data: chunk.map((w) => ({
            supercategory: w.supercategory,
            familyLabel: w.familyLabel,
            normalizedEntityId: w.normalizedEntityId,
            entityLabel: w.entityLabel,
            parentEntityId: w.parentEntityId,
            parentLabel: w.parentLabel,
            parentDescriptor: w.parentDescriptor,
            entityRole: w.entityRole,
            usageCount: w.usageCount,
            evidenced: w.evidenced,
            isGeneric: w.isGeneric,
            dominantKind: w.dominantKind,
            sourceArtifactSha: manifest.sha256,
          })),
          skipDuplicates: true,
        });
        entityRowsInserted += chunk.length;
      }
      for (let i = 0; i < entityResult.usageWrites.length; i += ENTITY_BATCH) {
        const chunk = entityResult.usageWrites.slice(i, i + ENTITY_BATCH);
        await tx.familyEntityUsage.createMany({
          data: chunk.map((w) => ({
            supercategory: w.supercategory,
            familyLabel: w.familyLabel,
            normalizedEntityId: w.normalizedEntityId,
            pmid: w.pmid,
            usageSentence: w.usageSentence,
            matchedSpanStart: w.matchedSpanStart,
            matchedSpanEnd: w.matchedSpanEnd,
            centralityScore:
              w.centralityScore == null ? null : new Prisma.Decimal(w.centralityScore),
            entityRole: w.entityRole,
            informativenessScore:
              w.informativenessScore == null ? null : new Prisma.Decimal(w.informativenessScore),
            mentionClass: w.mentionClass,
            sentenceComplete: w.sentenceComplete,
            sourceArtifactSha: manifest.sha256,
          })),
          skipDuplicates: true,
        });
        usageRowsInserted += chunk.length;
      }
    },
    { timeout: 120_000, maxWait: 10_000 },
  );

  log("write_complete", {
    rows: inserted,
    family_rows: familiesInserted,
    entity_rows: entityRowsInserted,
    entity_usage_rows: usageRowsInserted,
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
