/**
 * Spotlight ETL — Phase 9 SPOTLIGHT-02 (Plan 09-02).
 *
 * Sole writer of the `Spotlight` table. Fetches
 * s3://wcmc-reciterai-artifacts/spotlight/latest/manifest.json, short-circuits
 * on unchanged sha256, otherwise fetches the version-pinned
 * spotlight.schema.json + spotlight.json, validates with ajv 2020-12 (D-11
 * additive-fields tolerant), upserts the 10 spotlight rows, and deletes any
 * stale rows from prior publishes (full-replacement semantics).
 *
 * Source-of-truth contract: ~/Dropbox/GitHub/ReciterAI/docs/spotlight-contract.md
 * SPS coding-agent brief:   ~/Dropbox/GitHub/ReciterAI/docs/sps-spotlight-handoff.md
 * Reference script:         ~/Dropbox/GitHub/ReciterAI/docs/sps-spotlight-etl-reference.ts
 *
 * D-19 LOCKED reminder: display_name, short_description, and lede are
 * UI-facing only. NEVER pass them to an LLM, retrieval, or embedding path.
 * label / description (the latter on Subtopic, not here) are the
 * synthesis-canonical fields.
 *
 * Env:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION  (default us-east-1)
 *   ARTIFACTS_BUCKET                                              (default wcmc-reciterai-artifacts)
 *   ARTIFACT_PREFIX                                               (default spotlight)
 *
 * Usage:
 *   npm run etl:spotlight
 *   tsx etl/spotlight/index.ts
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import Ajv from "ajv/dist/2020"; // ajv v8+ with JSON Schema 2020-12 support
import { prisma } from "../../lib/db";

// ---------------------------------------------------------------------------
// Module-level env constants — use AWS SDK default credential chain; do NOT
// hardcode keys here. The SDK reads AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
// from the environment, or falls back to IAM role / instance profile.
// ---------------------------------------------------------------------------
const BUCKET = process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts";
const PREFIX = process.env.ARTIFACT_PREFIX ?? "spotlight";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";

// ---------------------------------------------------------------------------
// Type interfaces — mirror docs/spotlight.schema.json $defs (canonical source).
// ---------------------------------------------------------------------------

interface Author {
  personIdentifier: string;       // WCM faculty UID; SPS photo-store join key
  displayName: string;
  position: "first" | "last";
}

interface Paper {
  pmid: string;
  title: string;
  journal: string;
  year: number;
  first_author: Author;
  last_author: Author;
}

/**
 * One spotlight entry. The `lede` field is render-ready; do NOT pass it back
 * through any retrieval or synthesis LLM call (D-19).
 *
 * D-06 ID instability: subtopic_id is stable per-recompute but unstable
 * ACROSS recomputes. Each ETL run is a full replacement.
 */
interface Spotlight {
  subtopic_id: string;
  label: string;
  display_name?: string;          // UI card title; fallback to label upstream guarantees nonempty
  short_description?: string;     // UI card subtitle
  parent_topic: string;
  lede: string;                   // 25-35 word editorial lede; render verbatim
  papers: Paper[];                // 2-3 representative WCM publications
}

interface PoolSnapshotEntry {
  subtopic_id: string;
  pool_score: number;
  parent_topic: string;
  was_selected: boolean;
}

interface SpotlightArtifact {
  version: string;                // e.g. "spotlight_v1"
  generated_at: string;
  taxonomy_version: string;
  spotlights: Spotlight[];        // 1-10 active spotlights
  pool_snapshot: PoolSnapshotEntry[]; // up to 50 candidates (transparency only)
}

/** Seven-field manifest — insertion order is canonical; do not reorder. */
interface SpotlightManifest {
  schema_version: string;         // semver of spotlight.schema.json
  spotlight_version: string;      // artifact format, e.g. "spotlight_v1"
  taxonomy_version: string;       // inherited from upstream hierarchy
  version: string;                // publish version, e.g. "v2026-05-07"
  generated_at: string;
  sha256: string;                 // hex sha256 of spotlight.json bytes
  artifact_bytes: number;
}

// ---------------------------------------------------------------------------
// S3 helper
// ---------------------------------------------------------------------------

async function fetchText(s3: S3Client, key: string): Promise<string> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return resp.Body!.transformToString("utf-8");
}

// ---------------------------------------------------------------------------
// EtlRun helper — same pattern as etl/hierarchy/index.ts. The
// `manifestTaxonomyVersion` column is shared across sources; for Spotlight we
// store it diagnostically but do NOT branch on drift (taxonomy_version drift is
// the Hierarchy ETL's concern; spotlight inherits whatever the producer used).
// ---------------------------------------------------------------------------

async function recordRun(args: {
  status: "success" | "failed";
  rowsProcessed: number;
  manifest?: SpotlightManifest;
  errorMessage?: string;
}): Promise<void> {
  await prisma.etlRun.create({
    data: {
      source: "Spotlight",
      status: args.status,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
      manifestSha256: args.manifest?.sha256 ?? null,
      manifestTaxonomyVersion: args.manifest?.taxonomy_version ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Main ETL flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Step 1: initialize S3 client using the AWS SDK default credential chain.
  const s3 = new S3Client({ region: REGION });

  // Step 2: Fetch the latest manifest.
  const manifestText = await fetchText(s3, `${PREFIX}/latest/manifest.json`);
  const manifest: SpotlightManifest = JSON.parse(manifestText);
  console.log(
    `[Spotlight] ${JSON.stringify({
      event: "manifest_fetched",
      ts: Date.now(),
      version: manifest.version,
      schema_version: manifest.schema_version,
      spotlight_version: manifest.spotlight_version,
      taxonomy_version: manifest.taxonomy_version,
      sha256_prefix: manifest.sha256.slice(0, 12),
      artifact_bytes: manifest.artifact_bytes,
    })}`
  );

  // Step 3a: Find the prior successful Spotlight run.
  const lastRun = await prisma.etlRun.findFirst({
    where: { source: "Spotlight", status: "success" },
    orderBy: { completedAt: "desc" },
  });

  // Step 3b: sha256 short-circuit.
  if (lastRun?.manifestSha256 === manifest.sha256) {
    console.log(
      `[Spotlight] ${JSON.stringify({
        event: "short_circuit",
        ts: Date.now(),
        sha256: manifest.sha256,
        version: manifest.version,
        rows: 0,
      })}`
    );
    await recordRun({ status: "success", rowsProcessed: 0, manifest });
    return;
  }

  // Step 4: Fetch schema for this SPECIFIC version — NOT latest/ — to guard
  // against schema drift during the 30-day breaking-change deprecation window.
  // Always fetch schema and artifact from the SAME manifest.version prefix.
  const schemaText = await fetchText(s3, `${PREFIX}/${manifest.version}/spotlight.schema.json`);
  const schema = JSON.parse(schemaText);

  // Step 5: Fetch spotlight.json from the same version-specific prefix.
  const artifactText = await fetchText(s3, `${PREFIX}/${manifest.version}/spotlight.json`);
  const artifact: SpotlightArtifact = JSON.parse(artifactText);

  // Step 6: Validate against schema. D-11 additive-fields rule — `strict: false`
  // and no `additionalProperties: false` enforcement so additive bumps don't
  // break the consumer mid-publish.
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(schema);
  if (!validate(artifact)) {
    console.error(
      `[Spotlight] ${JSON.stringify({
        event: "schema_validation_failed",
        ts: Date.now(),
        errors: validate.errors,
      })}`
    );
    await recordRun({
      status: "failed",
      rowsProcessed: 0,
      manifest,
      errorMessage: `Schema validation failed: ${JSON.stringify(validate.errors)}`,
    });
    process.exit(1);
  }
  console.log(
    `[Spotlight] ${JSON.stringify({
      event: "schema_validation_passed",
      ts: Date.now(),
      spotlights: artifact.spotlights.length,
      pool_snapshot_size: artifact.pool_snapshot.length,
    })}`
  );

  // Step 7: Project the 10 active spotlights into MySQL. Each publish is a
  // FULL replacement (D-06 ID instability + contract §Subtopic ID Stability):
  // every artifact subtopic gets upserted, then any rows tagged with a
  // different artifact_version are deleted at the end of the loop.
  //
  // D-19 LOCKED upsert rule: write display_name, short_description, and lede
  // verbatim. The artifact-side `display_name` is allowed to be empty in
  // theory (D-19 carry-over) but the upstream lede generator guarantees a
  // nonempty value via `display_name || label` — so we apply the same fallback
  // here defensively.
  //
  // pool_snapshot is intentionally ignored (transparency-only per contract).
  const refreshedAt = new Date();
  let upserted = 0;
  for (const spotlight of artifact.spotlights) {
    await prisma.spotlight.upsert({
      where: { subtopicId: spotlight.subtopic_id },
      create: {
        subtopicId:       spotlight.subtopic_id,
        parentTopicId:    spotlight.parent_topic,
        label:            spotlight.label,
        displayName:      spotlight.display_name || spotlight.label,
        shortDescription: spotlight.short_description ?? "",
        lede:             spotlight.lede,
        papers:           spotlight.papers as unknown as object,
        artifactVersion:  manifest.version,
        refreshedAt,
      },
      update: {
        parentTopicId:    spotlight.parent_topic,
        label:            spotlight.label,
        displayName:      spotlight.display_name || spotlight.label,
        shortDescription: spotlight.short_description ?? "",
        lede:             spotlight.lede,
        papers:           spotlight.papers as unknown as object,
        artifactVersion:  manifest.version,
        refreshedAt,
      },
    });
    upserted++;
  }

  // Step 8: Drop any rows left over from a prior publish whose subtopic_id
  // was not in this artifact. Full-replacement semantics: the table reflects
  // exactly the current artifact's `spotlights[]`.
  const stale = await prisma.spotlight.deleteMany({
    where: { artifactVersion: { not: manifest.version } },
  });

  console.log(
    `[Spotlight] ${JSON.stringify({
      event: "upsert_complete",
      ts: Date.now(),
      rows: upserted,
      stale_deleted: stale.count,
      version: manifest.version,
      sha256: manifest.sha256.slice(0, 12) + "…",
    })}`
  );

  await recordRun({ status: "success", rowsProcessed: upserted, manifest });
}

main()
  .catch(async (err) => {
    console.error(
      `[Spotlight] ${JSON.stringify({
        event: "etl_failed",
        ts: Date.now(),
        error: String(err?.message ?? err),
      })}`
    );
    try {
      await recordRun({
        status: "failed",
        rowsProcessed: 0,
        errorMessage: String(err?.message ?? err),
      });
    } catch (recordErr) {
      console.error(`[Spotlight] could not record failed EtlRun:`, recordErr);
    }
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
