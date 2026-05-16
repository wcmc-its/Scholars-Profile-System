/**
 * Hierarchy ETL — Phase 8 (HIERARCHY-02 + HIERARCHY-04).
 *
 * Sole writer of the `Subtopic` table. Replaces the legacy DDB Block 2 upsert
 * (deleted in Plan 03). Fetches s3://wcmc-reciterai-hierarchy/latest/manifest.json,
 * short-circuits on unchanged sha256, otherwise fetches the version-pinned
 * hierarchy.schema.json + hierarchy.json, validates with ajv 2020-12 (D-11
 * additive-fields tolerant), and upserts ~2,010 subtopic rows including the
 * D-19 display_name + short_description fields.
 *
 * Source-of-truth contract: ~/Dropbox/GitHub/ReciterAI/docs/hierarchy-contract.md
 * Reference script:        ~/Dropbox/GitHub/ReciterAI/docs/sps-etl-reference.ts
 *
 * D-19 LOCKED reminder: display_name and short_description are UI-only.
 * NEVER pass them to an LLM, retrieval, or embedding path. label and
 * description are the synthesis-canonical fields. (No-op for SPS today;
 * no LLM call sites exist — see CONTEXT.md D-10.)
 *
 * Env:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION  (default us-east-1)
 *   HIERARCHY_BUCKET                                              (default wcmc-reciterai-hierarchy)
 *
 * Usage:
 *   npm run etl:hierarchy
 *   node --import tsx/esm etl/hierarchy/index.ts
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import Ajv from "ajv/dist/2020"; // ajv v8+ with JSON Schema 2020-12 support
import { prisma } from "../../lib/db";

// ---------------------------------------------------------------------------
// Module-level env constants — use AWS SDK default credential chain; do NOT
// hardcode keys here. The SDK reads AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
// from the environment, or falls back to IAM role / instance profile.
// ---------------------------------------------------------------------------
const BUCKET = process.env.HIERARCHY_BUCKET ?? "wcmc-reciterai-hierarchy";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";

// ---------------------------------------------------------------------------
// Type interfaces — mirror hierarchy-contract.md (canonical source).
// ---------------------------------------------------------------------------

/**
 * A single subtopic within a parent topic.
 *
 * D-19 field split (LOCKED):
 *   display_name / short_description — UI-facing, synthesis-forbidden
 *   label / description             — LLM synthesis-canonical
 *
 * D-06 ID instability: subtopic IDs are stable per-recompute but unstable
 * ACROSS recomputes. Never persist them in a table that outlives a recompute
 * cycle. The ETL upsert keyed on `id` is fine — each ETL run replaces the
 * prior value.
 */
interface SubtopicDef {
  id: string;
  label: string;
  description: string;
  display_name: string;       // D-19: UI card title
  short_description: string;  // D-19: UI card subtitle
  activity_count: number;     // integer — display only
  total_weight: number;       // sum of articleScores
}

interface TopicEntry {
  subtopics: SubtopicDef[];
  /// Issue #325 / ReciterAI #69 — per-topic display threshold (above the
  /// 0.3 score_floor). Optional in the artifact: untuned topics omit the
  /// field, the consumer falls back to 0.5. Forward-compatible — the
  /// current published artifact (v2026-05-13) predates RA#69 so the field
  /// is missing on every topic; the next producer publish carries it for
  /// tuned topics, untuned topics will continue to omit.
  display_threshold?: number;
}

interface ExcludedTopicEntry {
  id: string;
  reason: string;
  activity_count: number;
}

interface SeeAlsoEntry {
  from: string;
  to: string;
  reason: string;
}

interface HierarchyJson {
  version: "subtopic_v1";
  generated_at: string;
  taxonomy_version: string;
  excluded_topics: ExcludedTopicEntry[];
  topics: Record<string, TopicEntry>;
  see_also: SeeAlsoEntry[];
}

/** Six-field manifest — insertion order is canonical; do not reorder. */
interface HierarchyManifest {
  schema_version: string;    // semver of hierarchy.schema.json
  taxonomy_version: string;  // e.g. "taxonomy_v2"
  version: string;           // publish version, e.g. "v2026-05-06"
  generated_at: string;      // ISO 8601 UTC publish moment
  sha256: string;            // hex sha256 of hierarchy.json bytes
  artifact_bytes: number;    // byte length of hierarchy.json
}

// ---------------------------------------------------------------------------
// S3 helpers
// ---------------------------------------------------------------------------

async function fetchText(s3: S3Client, key: string): Promise<string> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return resp.Body!.transformToString("utf-8");
}

// ---------------------------------------------------------------------------
// EtlRun helper — the run row records sha256 + taxonomy_version for the
// next run's short-circuit logic. Used in three places: short-circuit success,
// full upsert success, and the catch block in the bottom-of-file wrapper.
// ---------------------------------------------------------------------------

async function recordRun(args: {
  status: "success" | "failed";
  rowsProcessed: number;
  manifest?: HierarchyManifest;
  errorMessage?: string;
}): Promise<void> {
  await prisma.etlRun.create({
    data: {
      source: "Hierarchy",
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
  // The SDK automatically reads AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or
  // falls back to IAM role / instance profile / ECS task role. No creds here.
  const s3 = new S3Client({ region: REGION });

  // Step 2: Fetch the latest manifest to determine whether the hierarchy has
  // changed since the last ETL run.
  const manifestText = await fetchText(s3, "latest/manifest.json");
  const manifest: HierarchyManifest = JSON.parse(manifestText);
  console.log(
    `[Hierarchy] ${JSON.stringify({
      event: "manifest_fetched",
      ts: Date.now(),
      version: manifest.version,
      schema_version: manifest.schema_version,
      taxonomy_version: manifest.taxonomy_version,
      sha256_prefix: manifest.sha256.slice(0, 12),
      artifact_bytes: manifest.artifact_bytes,
    })}`
  );

  // Step 3a: Find the prior successful Hierarchy run.
  const lastRun = await prisma.etlRun.findFirst({
    where: { source: "Hierarchy", status: "success" },
    orderBy: { completedAt: "desc" },
  });

  // Step 3b: Sha256 short-circuit. If the artifact hasn't changed, exit early.
  if (lastRun?.manifestSha256 === manifest.sha256) {
    // D-02 contradiction guard: sha256 covers the entire artifact bytes,
    // which include taxonomy_version. If sha256 matches but taxonomy_version
    // differs, something is wrong (truncation, tampering, manual edit, or a
    // logic error in the publisher). Bail loudly rather than upsert.
    if (
      lastRun.manifestTaxonomyVersion &&
      lastRun.manifestTaxonomyVersion !== manifest.taxonomy_version
    ) {
      console.error(
        `[Hierarchy] ${JSON.stringify({
          event: "sha256_taxonomy_version_contradiction",
          ts: Date.now(),
          stored_sha256: lastRun.manifestSha256,
          stored_taxonomy_version: lastRun.manifestTaxonomyVersion,
          manifest_taxonomy_version: manifest.taxonomy_version,
          note: "sha256 unchanged but taxonomy_version differs — investigate manifest integrity",
        })}`
      );
      process.exit(1);
    }
    console.log(
      `[Hierarchy] ${JSON.stringify({
        event: "short_circuit",
        ts: Date.now(),
        sha256: manifest.sha256,
        taxonomy_version: manifest.taxonomy_version,
        version: manifest.version,
        rows: 0,
      })}`
    );
    await recordRun({ status: "success", rowsProcessed: 0, manifest });
    return;
  }

  // Step 3c: D-02 / HIERARCHY-04 — taxonomy_version drift detection.
  // Fires whenever taxonomy_version changes between successful runs. This is
  // the early-warning signal for the deferred PublicationTopic FK remediation
  // work (CONTEXT.md A1-D1 / Deferred Ideas). The ETL still continues — D-02
  // says log WARN, do NOT refuse to upsert.
  if (
    lastRun?.manifestTaxonomyVersion &&
    lastRun.manifestTaxonomyVersion !== manifest.taxonomy_version
  ) {
    console.warn(
      `[Hierarchy] ${JSON.stringify({
        event: "taxonomy_version_changed",
        ts: Date.now(),
        prior_taxonomy_version: lastRun.manifestTaxonomyVersion,
        new_taxonomy_version: manifest.taxonomy_version,
        note: "PublicationTopic FK remediation may be required; see contract Changelog at ~/Dropbox/GitHub/ReciterAI/docs/hierarchy-contract.md",
      })}`
    );
  }

  // Step 4: Fetch schema for this SPECIFIC version — NOT latest/ — to guard
  // against schema drift during the 30-day breaking-change deprecation window.
  // Always fetch schema and hierarchy from the SAME manifest.version prefix.
  const schemaText = await fetchText(s3, `${manifest.version}/hierarchy.schema.json`);
  const schema = JSON.parse(schemaText);

  // Step 5: Fetch hierarchy.json from the same version-specific prefix.
  const hierarchyText = await fetchText(s3, `${manifest.version}/hierarchy.json`);
  const hierarchy: HierarchyJson = JSON.parse(hierarchyText);

  // Step 6: Validate hierarchy against schema (fail-fast — do NOT write to
  // MySQL if the schema is invalid). This mirrors the producer-side validation
  // gate in backfill_all.py --publish (D-16 consumer mirror).
  //
  // D-11 additive-fields rule: unknown keys must be silently tolerated so an
  // additive schema bump never breaks the consumer mid-publish. We therefore
  // do NOT enforce strict additional-properties checking. `strict: false`
  // suppresses ajv's own strict-mode warnings for keywords it doesn't
  // recognize.
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(schema);
  if (!validate(hierarchy)) {
    console.error(
      `[Hierarchy] ${JSON.stringify({
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
    `[Hierarchy] ${JSON.stringify({
      event: "schema_validation_passed",
      ts: Date.now(),
    })}`
  );

  // Step 6b: Editorial integrity check for `display_name`.
  //
  // Issue #175: a runtime sentence-case normalizer used to compensate for
  // parent-prefix contamination and missing editorial casing in the artifact.
  // That normalizer was deleted because it corrupted semantically-meaningful
  // casing (e.g. "CAR T cell" → "CAR t cell"). The renderer now trusts
  // `display_name` verbatim. To keep that contract honest we validate the
  // artifact at import time: every subtopic must have a non-empty display_name
  // whose first word is not the same as a word in the parent topic's label
  // (the historical contamination pattern was "Neurodegenerative Glymphatic …"
  // under parent "Neurodegenerative Disease"). Violations are logged as WARN
  // and the row is still upserted — same posture as taxonomy_version drift.
  // Surfacing the count in the run log gives an early signal to fix upstream.
  const parentTopics = await prisma.topic.findMany({ select: { id: true, label: true } });
  const parentWordsByTopicId = new Map<string, Set<string>>();
  for (const t of parentTopics) {
    parentWordsByTopicId.set(
      t.id,
      new Set(
        t.label
          .toLowerCase()
          .replace(/[^a-z0-9 ]/g, "")
          .split(" ")
          .filter(Boolean)
      )
    );
  }
  let editorialWarnings = 0;
  for (const [topicId, topicEntry] of Object.entries(hierarchy.topics)) {
    const parentWords = parentWordsByTopicId.get(topicId);
    for (const subtopic of topicEntry.subtopics) {
      const display = subtopic.display_name?.trim() ?? "";
      if (!display) {
        editorialWarnings++;
        console.warn(
          `[Hierarchy] ${JSON.stringify({
            event: "editorial_warning_empty_display_name",
            ts: Date.now(),
            topic_id: topicId,
            subtopic_id: subtopic.id,
            label: subtopic.label,
          })}`
        );
        continue;
      }
      if (parentWords && parentWords.size > 0) {
        const firstWord = display.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
        if (firstWord && parentWords.has(firstWord)) {
          editorialWarnings++;
          console.warn(
            `[Hierarchy] ${JSON.stringify({
              event: "editorial_warning_parent_prefix",
              ts: Date.now(),
              topic_id: topicId,
              subtopic_id: subtopic.id,
              display_name: display,
              first_word: firstWord,
              note: "display_name starts with a parent-topic word; fix at ReCiterAI source",
            })}`
          );
        }
      }
    }
  }
  console.log(
    `[Hierarchy] ${JSON.stringify({
      event: "editorial_validation_complete",
      ts: Date.now(),
      warnings: editorialWarnings,
    })}`
  );

  // Step 7: Project hierarchy to MySQL Subtopic table.
  //
  // Each ETL run is a full replacement: every artifact subtopic gets upserted.
  // We do NOT delete subtopic rows that are absent from the new artifact in
  // this phase — the legacy DDB Block 2 created some rows that may not exist
  // in the artifact. Plan 03 deletes Block 2; from that point forward Hierarchy
  // ETL is the sole writer and orphan rows naturally drop out of UI surfaces
  // because PublicationTopic counts go to zero on the next DDB ETL run.
  //
  // D-19 LOCKED upsert rule: write display_name and short_description verbatim
  // from the artifact. Do NOT fall back to label inside the upsert (the UI
  // does the `display_name ?? label` fallback at render time per Plan 04).
  // Empty strings are stored as empty strings; the schema columns are nullable
  // but the artifact always provides strings.
  let upserted = 0;
  for (const [topicId, topicEntry] of Object.entries(hierarchy.topics)) {
    for (const subtopic of topicEntry.subtopics) {
      await prisma.subtopic.upsert({
        where: { id: subtopic.id },
        create: {
          id:               subtopic.id,
          parentTopicId:    topicId,
          label:            subtopic.label,
          description:      subtopic.description ?? null,
          displayName:      subtopic.display_name,
          shortDescription: subtopic.short_description,
          activityCount:    subtopic.activity_count,
          totalWeight:      subtopic.total_weight,
          source:           `reciterai-hierarchy_${manifest.version}`,
          refreshedAt:      new Date(),
        },
        update: {
          parentTopicId:    topicId,
          label:            subtopic.label,
          description:      subtopic.description ?? null,
          displayName:      subtopic.display_name,
          shortDescription: subtopic.short_description,
          activityCount:    subtopic.activity_count,
          totalWeight:      subtopic.total_weight,
          source:           `reciterai-hierarchy_${manifest.version}`,
          refreshedAt:      new Date(),
        },
      });
      upserted++;
    }
  }

  console.log(
    `[Hierarchy] ${JSON.stringify({
      event: "upsert_complete",
      ts: Date.now(),
      rows: upserted,
      version: manifest.version,
      taxonomy_version: manifest.taxonomy_version,
      sha256: manifest.sha256.slice(0, 12) + "…",
    })}`
  );

  // Step 8: Issue #325 — write per-topic `display_threshold` to Topic.
  //
  // The hierarchy artifact carries `display_threshold` per ReciterAI #69 — a
  // second threshold above the 0.3 `score_floor` driving the two-tier display
  // on /topics/<slug> (#326 PR-1). Untuned topics omit the field; we write
  // null so the consumer falls back to the spec default (0.5) via
  // `topic.displayThreshold ?? 0.5`. Storing null (rather than defaulting at
  // the column) keeps "untuned" distinguishable from "tuned to 0.5" for the
  // tuning workstream tracker.
  //
  // FK guard: the Topic catalog is owned by the DynamoDB ETL Block 1 (TAXONOMY#)
  // which runs after this ETL per etl/orchestrate.ts. On a fresh database the
  // Topic table may not exist yet on the first run; we tolerate that by skipping
  // unknown topic ids and logging the count.
  const knownTopicIds = new Set(
    parentTopics.map((t) => t.id), // parentTopics already loaded above for editorial check
  );
  let thresholdsSet = 0;
  let thresholdsCleared = 0;
  let thresholdsSkippedUnknown = 0;
  for (const [topicId, topicEntry] of Object.entries(hierarchy.topics)) {
    if (!knownTopicIds.has(topicId)) {
      thresholdsSkippedUnknown++;
      continue;
    }
    const value =
      typeof topicEntry.display_threshold === "number" &&
      Number.isFinite(topicEntry.display_threshold)
        ? topicEntry.display_threshold
        : null;
    await prisma.topic.update({
      where: { id: topicId },
      data: { displayThreshold: value },
    });
    if (value !== null) thresholdsSet++;
    else thresholdsCleared++;
  }
  console.log(
    `[Hierarchy] ${JSON.stringify({
      event: "display_threshold_complete",
      ts: Date.now(),
      tuned: thresholdsSet,
      untuned: thresholdsCleared,
      skipped_unknown_topic: thresholdsSkippedUnknown,
    })}`
  );

  await recordRun({ status: "success", rowsProcessed: upserted, manifest });
}

main()
  .catch(async (err) => {
    console.error(
      `[Hierarchy] ${JSON.stringify({
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
      console.error(`[Hierarchy] could not record failed EtlRun:`, recordErr);
    }
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
