/**
 * #2166 — ReciterAI's `config/excluded_topics.json` governance list is
 * co-published inside the hierarchy artifact (`hierarchy.json.excluded_topics`)
 * that etl/hierarchy/index.ts already fetches -- but that ETL runs only
 * annually, and nothing else ever reads the field. Block 1 (TAXONOMY# ->
 * topic, nightly) reads it too so a topic ReciterAI marks excluded (e.g.
 * "Oral & Craniofacial Health") never lands in the `topic` catalog even
 * though ReciterAI's TAXONOMY# record still lists it.
 *
 * Same bucket/creds as etl/hierarchy (HIERARCHY_BUCKET; task-role IAM shared
 * across every step on this task def, no new grant needed).
 *
 * Soft-fails: any fetch/parse/integrity error logs a warning and returns an
 * empty set rather than throwing -- Dynamodb is tier:"abort" in the nightly
 * chain, and a hierarchy-bucket hiccup must not take the whole chain down
 * over a supplementary exclusion check.
 */
import { createHash } from "node:crypto";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const BUCKET = process.env.HIERARCHY_BUCKET ?? "wcmc-reciterai-hierarchy";
const REGION = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";

async function fetchBytes(s3: S3Client, key: string): Promise<Uint8Array> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return resp.Body!.transformToByteArray();
}

export async function fetchExcludedTopicIds(): Promise<Set<string>> {
  try {
    const s3 = new S3Client({ region: REGION });
    const manifestBytes = await fetchBytes(s3, "latest/manifest.json");
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf-8"));
    const hierarchyBytes = await fetchBytes(s3, `${manifest.version}/hierarchy.json`);

    // §4.3-style integrity check (mirrors etl/hierarchy/index.ts): verify the
    // fetched bytes against the manifest's declared sha256 before trusting them.
    const digest = createHash("sha256").update(hierarchyBytes).digest("hex");
    if (!manifest.sha256 || digest !== manifest.sha256) {
      console.warn(
        `[Dynamodb] excluded_topics: sha256 mismatch on hierarchy.json (expected ${manifest.sha256}, got ${digest}) -- skipping exclusion enforcement this run.`,
      );
      return new Set();
    }

    const hierarchy = JSON.parse(Buffer.from(hierarchyBytes).toString("utf-8"));
    const excluded = Array.isArray(hierarchy.excluded_topics) ? hierarchy.excluded_topics : [];
    const ids = excluded
      .map((e: unknown) =>
        e && typeof (e as { id?: unknown }).id === "string" ? (e as { id: string }).id : null,
      )
      .filter((id: string | null): id is string => id !== null);
    console.log(
      `[Dynamodb] excluded_topics: ${ids.length} id(s) from hierarchy ${manifest.version}.`,
    );
    return new Set(ids);
  } catch (err) {
    console.warn(
      `[Dynamodb] excluded_topics fetch failed -- skipping exclusion enforcement this run: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Set();
  }
}
