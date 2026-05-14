/**
 * MeSH Descriptor ETL — spec §1.3 (taxonomy-aware unified search, Phase 1).
 *
 * Yearly cadence: NLM publishes desc<year>.xml in November. Mid-year update
 * files are run on demand via the same `npm run etl:mesh` script.
 *
 * Pipeline:
 *   1. Resolve year: try desc<currentYear>.xml; on 404 fall back to
 *      desc<currentYear-1>.xml (covers Jan-Oct when NLM hasn't yet shipped
 *      the new year).
 *   2. Stream-fetch the file from NLM; tee the byte stream into (a) a
 *      sha256 hash and (b) the sax-based DescriptorRecord parser.
 *   3. Short-circuit if the prior successful EtlRun's manifestSha256 matches
 *      what we just computed. Skips DB write + S3 upload entirely.
 *   4. Otherwise: full-replace the MeshDescriptor table inside a long-running
 *      transaction (deleteMany + chunked createMany).
 *   5. Build synonyms.txt body via the collision-filtering builder
 *      (etl/mesh-descriptors/synonyms.ts) and upload to
 *      s3://${MESH_SYNONYM_BUCKET}/synonyms/mesh-<year>.txt.
 *   6. Record run in EtlRun with sha256 + year for next short-circuit pass.
 *
 * Out of scope (deferred to §1.5 / §1.10):
 *   - In-memory descriptor map for query-time concept resolution.
 *   - Wiring the uploaded file into OpenSearch's `mesh_synonyms`
 *     synonym_graph filter on the publications index.
 *
 * Not wired into etl/orchestrate.ts on purpose — yearly cadence, not daily.
 *
 * Env:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION (default us-east-1)
 *   MESH_SYNONYM_BUCKET (default scholars-search-config)
 *   MESH_YEAR_OVERRIDE  (optional, e.g. "2026" to force a specific year)
 *   MESH_FORCE_REPLACE  (set to "1" to bypass sha256 short-circuit)
 */
import { createHash } from "node:crypto";
import { Readable, PassThrough } from "node:stream";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db";
import { parseMeshXmlStream, type ParsedDescriptor } from "./parser";
import { buildSynonyms } from "./synonyms";

const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const BUCKET = process.env.MESH_SYNONYM_BUCKET ?? "scholars-search-config";
const NLM_BASE = "https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh";
const FORCE_REPLACE = process.env.MESH_FORCE_REPLACE === "1";

// MariaDB JSON columns are mapped through Prisma's InputJsonValue.
type JsonStringArray = Prisma.InputJsonValue;

function asJsonStringArray(arr: string[]): JsonStringArray {
  return arr as unknown as JsonStringArray;
}

interface ResolvedSource {
  year: string;
  url: string;
}

/**
 * Try desc<year>.xml then desc<year-1>.xml. NLM ships in November so the
 * Jan-Oct window of any calendar year has no current-year file yet.
 */
async function resolveSourceUrl(): Promise<ResolvedSource> {
  const override = process.env.MESH_YEAR_OVERRIDE;
  const currentYear = override ? Number(override) : new Date().getUTCFullYear();
  const candidates = [String(currentYear), String(currentYear - 1)];
  for (const year of candidates) {
    const url = `${NLM_BASE}/desc${year}.xml`;
    const head = await fetch(url, { method: "HEAD" });
    if (head.ok) return { year, url };
    if (head.status !== 404 && head.status !== 403) {
      throw new Error(`HEAD ${url} → ${head.status} ${head.statusText}`);
    }
  }
  throw new Error(
    `No NLM MeSH descriptor file found for ${candidates.join(" or ")} under ${NLM_BASE}`,
  );
}

/**
 * Fetch the descriptor XML as a Node Readable while teeing bytes into a
 * sha256 hash. The Web Fetch ReadableStream is converted via Readable.fromWeb
 * and piped through a PassThrough that taps the byte stream.
 */
async function fetchWithHash(url: string): Promise<{
  stream: Readable;
  done: Promise<{ sha256: string; bytes: number }>;
}> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GET ${url} → ${resp.status} ${resp.statusText}`);
  if (!resp.body) throw new Error(`GET ${url} → empty body`);
  const nodeStream = Readable.fromWeb(resp.body as unknown as import("node:stream/web").ReadableStream);
  const hash = createHash("sha256");
  let bytes = 0;
  const tee = new PassThrough();
  nodeStream.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  nodeStream.pipe(tee);
  const done = new Promise<{ sha256: string; bytes: number }>((resolve, reject) => {
    nodeStream.on("end", () => resolve({ sha256: hash.digest("hex"), bytes }));
    nodeStream.on("error", reject);
  });
  return { stream: tee, done };
}

async function recordRun(args: {
  status: "success" | "failed";
  rowsProcessed: number;
  sha256?: string;
  year?: string;
  errorMessage?: string;
}): Promise<void> {
  await prisma.etlRun.create({
    data: {
      source: "MeSH",
      status: args.status,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
      manifestSha256: args.sha256 ?? null,
      manifestTaxonomyVersion: args.year ?? null,
    },
  });
}

async function uploadSynonyms(year: string, body: string): Promise<string> {
  const s3 = new S3Client({ region: REGION });
  const key = `synonyms/mesh-${year}.txt`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: "text/plain; charset=utf-8",
    }),
  );
  return `s3://${BUCKET}/${key}`;
}

async function replaceTable(rows: ParsedDescriptor[]): Promise<number> {
  // Full-table replacement inside one transaction. ~30k rows → batch in
  // chunks of 500 (Prisma's createMany bind-param limit is generous on
  // MariaDB but small chunks keep memory + lock duration predictable).
  const CHUNK = 500;
  const chunks: ParsedDescriptor[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));

  // Bump the transaction timeout — default 5s is far too short for a
  // 30k-row replace. 5min ceiling matches the longest other ETL upserts.
  await prisma.$transaction(
    async (tx) => {
      await tx.meshDescriptor.deleteMany({});
      for (const batch of chunks) {
        await tx.meshDescriptor.createMany({
          data: batch.map((d) => ({
            descriptorUi: d.descriptorUi,
            name: d.name,
            entryTerms: asJsonStringArray(d.entryTerms),
            treeNumbers: asJsonStringArray(d.treeNumbers),
            scopeNote: d.scopeNote,
            dateRevised: d.dateRevised ? new Date(d.dateRevised) : null,
            refreshedAt: new Date(),
          })),
        });
      }
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 },
  );

  return rows.length;
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  // Step 1: resolve year + URL with current-year-then-prior-year fallback.
  const src = await resolveSourceUrl();
  console.log(
    `[MeSH] ${JSON.stringify({
      event: "source_resolved",
      ts: Date.now(),
      year: src.year,
      url: src.url,
    })}`,
  );

  // Step 2: fetch with sha256 tee, stream-parse DescriptorRecord elements.
  const { stream, done } = await fetchWithHash(src.url);
  const descriptors: ParsedDescriptor[] = [];
  let firstRecord: string | null = null;
  for await (const d of parseMeshXmlStream(stream)) {
    descriptors.push(d);
    if (!firstRecord) firstRecord = d.descriptorUi;
  }
  const { sha256, bytes } = await done;
  console.log(
    `[MeSH] ${JSON.stringify({
      event: "parse_complete",
      ts: Date.now(),
      descriptors: descriptors.length,
      bytes,
      sha256_prefix: sha256.slice(0, 12),
      first_record: firstRecord,
    })}`,
  );

  if (descriptors.length === 0) {
    await recordRun({
      status: "failed",
      rowsProcessed: 0,
      sha256,
      year: src.year,
      errorMessage: "parser yielded zero descriptors — likely XML schema drift",
    });
    process.exit(1);
  }

  // Step 3: sha256 short-circuit against last successful run.
  const lastRun = await prisma.etlRun.findFirst({
    where: { source: "MeSH", status: "success" },
    orderBy: { completedAt: "desc" },
  });
  if (!FORCE_REPLACE && lastRun?.manifestSha256 === sha256) {
    console.log(
      `[MeSH] ${JSON.stringify({
        event: "short_circuit",
        ts: Date.now(),
        sha256: sha256,
        year: src.year,
        rows: 0,
      })}`,
    );
    await recordRun({ status: "success", rowsProcessed: 0, sha256, year: src.year });
    return;
  }

  // Step 4: full-replace MeshDescriptor table.
  const rows = await replaceTable(descriptors);
  console.log(
    `[MeSH] ${JSON.stringify({
      event: "table_replaced",
      ts: Date.now(),
      rows,
    })}`,
  );

  // Step 5: build collision-filtered synonyms.txt body + upload.
  const syn = buildSynonyms(descriptors);
  const body = syn.lines.join("\n") + "\n";
  console.log(
    `[MeSH] ${JSON.stringify({
      event: "synonyms_built",
      ts: Date.now(),
      lines: syn.lines.length,
      dropped_surface_forms: syn.droppedSurfaceForms.length,
      descriptors_without_synonyms: syn.descriptorsWithoutSynonyms,
      bytes: Buffer.byteLength(body, "utf-8"),
    })}`,
  );
  const s3Uri = await uploadSynonyms(src.year, body);
  console.log(
    `[MeSH] ${JSON.stringify({
      event: "synonyms_uploaded",
      ts: Date.now(),
      s3: s3Uri,
    })}`,
  );

  // Step 6: record run.
  await recordRun({ status: "success", rowsProcessed: rows, sha256, year: src.year });
  console.log(
    `[MeSH] ${JSON.stringify({
      event: "done",
      ts: Date.now(),
      duration_ms: Date.now() - startedAt,
    })}`,
  );
}

main()
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[MeSH] ${JSON.stringify({ event: "fatal", ts: Date.now(), error: message })}`);
    await recordRun({
      status: "failed",
      rowsProcessed: 0,
      errorMessage: message,
    }).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
