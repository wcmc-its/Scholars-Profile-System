/**
 * Stopgap producer for the Hierarchy artifact (s3://wcmc-reciterai-hierarchy).
 *
 * Background: Phase 8 wired SPS to consume `hierarchy.json` + `manifest.json`
 * from S3 (etl/hierarchy/index.ts), but the upstream ReciterAI pipeline that
 * publishes those artifacts has not yet provisioned the bucket or pushed the
 * canonical artifact. The augmented per-topic JSON files in the integration
 * repo at `.planning/phases/04-subtopic-system/hierarchy_augmented_*.json`
 * happen to contain everything we need (id, label, description, display_name,
 * short_description, activity_count, total_weight) — they are the per-topic
 * intermediate output from upstream, just not bundled into one artifact.
 *
 * This script bundles them. It is read-only on the integration repo, writes
 * the consolidated artifact + schema + manifest to `out/hierarchy/<version>/`
 * locally, and then `upload-hierarchy-to-s3.ts` pushes the result to S3.
 *
 * When upstream eventually publishes their canonical artifact, our manifest's
 * `taxonomy_version` will differ from theirs and the ETL will emit the
 * documented WARN per HIERARCHY-04 / D-02. Replace the bucket contents and
 * the next ETL run picks up the new data with no SPS code change.
 *
 * Usage:
 *   npx tsx scripts/generate-hierarchy-artifact.ts
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import Ajv from "ajv/dist/2020";

const INTEGRATION_REPO =
  "/Users/paulalbert/Dropbox/GitHub/ReciterAI -ReCiter-Integration";
const AUGMENTED_DIR = resolve(
  INTEGRATION_REPO,
  ".planning/phases/04-subtopic-system",
);
const SCHEMA_SRC = resolve(INTEGRATION_REPO, "docs/hierarchy.schema.json");

const TAXONOMY_VERSION = "1.0.0-sps-stopgap-2026-05-07";
const today = new Date().toISOString().slice(0, 10);
const VERSION = `v${today}-sps-stopgap`;

const OUT_DIR = resolve(process.cwd(), "out/hierarchy", VERSION);

type AugmentedSubtopic = {
  id: string;
  label: string;
  description?: string;
  display_name: string;
  short_description: string;
  activity_count: number;
  total_weight: number;
  // Other fields (seed_pmids, coverage_estimate) are tolerated but not copied.
};

type AugmentedFile = {
  topic_id: string;
  subtopics: AugmentedSubtopic[];
};

type SubtopicDef = {
  id: string;
  label: string;
  description: string;
  display_name: string;
  short_description: string;
  activity_count: number;
  total_weight: number;
};

type HierarchyJson = {
  version: "subtopic_v1";
  generated_at: string;
  taxonomy_version: string;
  excluded_topics: Array<{ id: string; reason: string; activity_count: number }>;
  topics: Record<string, { subtopics: SubtopicDef[] }>;
  see_also: Array<{ from: string; to: string; reason: string }>;
};

type Manifest = {
  schema_version: string;
  taxonomy_version: string;
  version: string;
  generated_at: string;
  sha256: string;
  artifact_bytes: number;
};

function loadAugmented(): AugmentedFile[] {
  const files = readdirSync(AUGMENTED_DIR)
    .filter((n) => n.startsWith("hierarchy_augmented_") && n.endsWith(".json"))
    .map((n) => resolve(AUGMENTED_DIR, n));
  return files.map((path) => {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as AugmentedFile;
    if (!parsed.topic_id || !Array.isArray(parsed.subtopics)) {
      throw new Error(`Malformed augmented file: ${path}`);
    }
    return parsed;
  });
}

function buildHierarchy(augmented: AugmentedFile[]): HierarchyJson {
  const topics: HierarchyJson["topics"] = {};
  for (const file of augmented) {
    const subtopics: SubtopicDef[] = file.subtopics.map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description ?? "",
      display_name: s.display_name,
      short_description: s.short_description,
      activity_count: s.activity_count,
      total_weight: s.total_weight,
    }));
    topics[file.topic_id] = { subtopics };
  }
  return {
    version: "subtopic_v1",
    generated_at: new Date().toISOString(),
    taxonomy_version: TAXONOMY_VERSION,
    excluded_topics: [],
    topics,
    see_also: [],
  };
}

function validate(hierarchy: HierarchyJson, schemaText: string): void {
  const schema = JSON.parse(schemaText);
  const ajv = new Ajv({ strict: false });
  const validateFn = ajv.compile(schema);
  if (!validateFn(hierarchy)) {
    console.error(
      JSON.stringify(
        { event: "schema_validation_failed", errors: validateFn.errors },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

function main(): void {
  console.log(`[generate] reading augmented files from ${AUGMENTED_DIR}`);
  const augmented = loadAugmented();
  const totalSubtopics = augmented.reduce((n, f) => n + f.subtopics.length, 0);
  console.log(
    `[generate] loaded ${augmented.length} topics, ${totalSubtopics} subtopics`,
  );

  const schemaText = readFileSync(SCHEMA_SRC, "utf-8");
  const hierarchy = buildHierarchy(augmented);
  validate(hierarchy, schemaText);
  console.log(`[generate] schema validation passed`);

  // Canonicalize: stable key ordering for sha256 stability across runs.
  // Object.entries on the topics map preserves insertion order in modern JS
  // engines. We sort keys to make the output reproducible.
  const sortedTopics: HierarchyJson["topics"] = {};
  for (const key of Object.keys(hierarchy.topics).sort()) {
    sortedTopics[key] = hierarchy.topics[key];
  }
  const canonicalHierarchy: HierarchyJson = {
    ...hierarchy,
    topics: sortedTopics,
  };

  const hierarchyText = JSON.stringify(canonicalHierarchy, null, 2);
  const sha256 = createHash("sha256").update(hierarchyText).digest("hex");
  const artifactBytes = Buffer.byteLength(hierarchyText, "utf-8");

  const manifest: Manifest = {
    schema_version: "1.0.0",
    taxonomy_version: TAXONOMY_VERSION,
    version: VERSION,
    generated_at: canonicalHierarchy.generated_at,
    sha256,
    artifact_bytes: artifactBytes,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, "hierarchy.json"), hierarchyText);
  writeFileSync(resolve(OUT_DIR, "hierarchy.schema.json"), schemaText);
  writeFileSync(resolve(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        event: "artifact_written",
        out_dir: OUT_DIR,
        version: VERSION,
        taxonomy_version: TAXONOMY_VERSION,
        topics: augmented.length,
        subtopics: totalSubtopics,
        sha256_prefix: sha256.slice(0, 12),
        artifact_bytes: artifactBytes,
      },
      null,
      2,
    ),
  );
}

main();
