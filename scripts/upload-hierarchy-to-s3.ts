/**
 * Uploads the locally-generated hierarchy artifact to S3.
 *
 * Bucket layout produced (matches what etl/hierarchy/index.ts expects):
 *   <bucket>/<version>/hierarchy.json
 *   <bucket>/<version>/hierarchy.schema.json
 *   <bucket>/latest/manifest.json
 *
 * If the bucket does not exist, this script creates it (us-east-1, no public
 * access, server-side encryption defaulted by S3). If it already exists and is
 * owned by another principal, the create call returns a clean error and we
 * abort — we never overwrite a foreign bucket.
 *
 * Usage:
 *   npx tsx scripts/upload-hierarchy-to-s3.ts <version-dir>
 *
 * Example:
 *   npx tsx scripts/upload-hierarchy-to-s3.ts out/hierarchy/v2026-05-07-sps-stopgap
 */
import { readFileSync, existsSync } from "fs";
import { resolve, basename } from "path";
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const BUCKET = process.env.HIERARCHY_BUCKET ?? "wcmc-reciterai-hierarchy";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";

async function ensureBucket(s3: S3Client): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`[upload] bucket ${BUCKET} already exists`);
    return;
  } catch (err: unknown) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") {
      // Proceed to create.
    } else {
      throw err;
    }
  }
  console.log(`[upload] creating bucket ${BUCKET} in ${REGION}`);
  await s3.send(
    new CreateBucketCommand({
      Bucket: BUCKET,
      // us-east-1 is the only region where you must NOT pass
      // CreateBucketConfiguration.LocationConstraint. All other regions require it.
      ...(REGION !== "us-east-1"
        ? { CreateBucketConfiguration: { LocationConstraint: REGION as never } }
        : {}),
    }),
  );
  console.log(`[upload] bucket ${BUCKET} created`);
}

async function putObject(
  s3: S3Client,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  console.log(`[upload] put s3://${BUCKET}/${key} (${body.length} bytes)`);
}

async function main(): Promise<void> {
  const versionDir = resolve(process.argv[2] ?? "out/hierarchy");
  if (!existsSync(versionDir)) {
    console.error(`[upload] version dir not found: ${versionDir}`);
    process.exit(1);
  }
  const version = basename(versionDir);

  const hierarchyPath = resolve(versionDir, "hierarchy.json");
  const schemaPath = resolve(versionDir, "hierarchy.schema.json");
  const manifestPath = resolve(versionDir, "manifest.json");
  for (const p of [hierarchyPath, schemaPath, manifestPath]) {
    if (!existsSync(p)) {
      console.error(`[upload] required file missing: ${p}`);
      process.exit(1);
    }
  }

  const hierarchyBuf = readFileSync(hierarchyPath);
  const schemaBuf = readFileSync(schemaPath);
  const manifestBuf = readFileSync(manifestPath);

  const s3 = new S3Client({ region: REGION });
  await ensureBucket(s3);

  // Upload version-pinned artifacts FIRST. The ETL fetches `latest/manifest.json`
  // and follows it to the version-pinned hierarchy + schema. If we wrote
  // manifest first and the version objects landed second, a concurrent ETL run
  // could read a manifest pointing at non-existent objects.
  await putObject(s3, `${version}/hierarchy.json`, hierarchyBuf, "application/json");
  await putObject(s3, `${version}/hierarchy.schema.json`, schemaBuf, "application/json");
  await putObject(s3, `latest/manifest.json`, manifestBuf, "application/json");

  console.log(
    JSON.stringify(
      {
        event: "upload_complete",
        bucket: BUCKET,
        region: REGION,
        version,
        keys: [
          `${version}/hierarchy.json`,
          `${version}/hierarchy.schema.json`,
          `latest/manifest.json`,
        ],
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`[upload] failed:`, err);
  process.exit(1);
});
