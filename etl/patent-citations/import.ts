/**
 * Patent-citations IMPORT: US patents that cite our publications, from the
 * Reliance on Science dataset (Marx and Fuegi; Zenodo, CC BY-NC 4.0), with
 * patent details from the PatentsView tables (USPTO).
 *
 * The dataset and the patent tables are several GB and stay on the operator's
 * laptop. An extract there writes one gzipped NDJSON file; the operator uploads
 * it to `scratch-input/patent-citations/` in the curation-backup bucket (the
 * prefix the ETL task role can read), and this importer runs in the VPC as a
 * one-off `run-task` on the base family `sps-etl-<env>`. `--file <path>` reads
 * a local file instead. A dataset release is a manual trigger: nothing
 * schedules this.
 *
 * What it writes (load.ts):
 *   - `citing_document`: one row per patent document, `source` 'ros', `level`
 *     'patent', `dedup_key` its family key, `details` the patent facts.
 *   - `publication_citing_document`: one row per paper and patent document,
 *     `evidence` `{ score, where, release }`.
 *   - `publication_openalex`: the paper mapping the extract used.
 *   - `publication.patent_family_count`: distinct inventions citing the paper.
 * 'patent' is not a ranked level (`POLICY_LEVELS`), so report 24, the public
 * badges, the publication modal and the Bibliometrics tab do not see any of it.
 * Re-running the same file changes nothing. Nothing is deleted.
 *
 * SAFETY, each a refusal before any write:
 *   - the file's row counts differ from its own header (a cut-off upload);
 *   - the file's tie-break winners differ from the rule here (shape.ts);
 *   - more than 2% of this environment's publications were never considered by
 *     the extract, which was built from another database's publication list
 *     (guard `patent-citations:publications-considered`);
 *   - the file holds over 20% fewer documents or links than the last load
 *     (guards `patent-citations:documents`, `patent-citations:links`).
 * Bypass a guard deliberately with ETL_GUARD_BYPASS="<guard>".
 *
 * EXTRACT FILE FORMAT (format 1). Gzipped NDJSON, one object per line, `t`
 * names the row type. The header is the first line; the rest may come in any
 * order. It holds PMIDs, OpenAlex ids and public patent data only: nothing
 * about scholars.
 *
 *   {"t":"header","format":1,"release":"zenodo:<record id>","metadataRelease":"YYYY-MM-DD",
 *    "mappedAt":"YYYY-MM-DD","counts":{"considered":n,"map":n,"tie":n,"doc":n,"link":n}}
 *       `counts` are distinct PMIDs for `considered` and rows for the others.
 *   {"t":"considered","pmids":["111","222"]}
 *       Every publication the extract looked up, in as many rows as it likes.
 *   {"t":"map","pmid":"111","openalexId":"W123","source":"api"|"crosswalk-2023"}
 *       A paper's OpenAlex work id. A shared id appears for its winner only.
 *   {"t":"tie","openalexId":"W123","workYear":2005,"workDoi":"10.1/x","crosswalkHasOwnWork":false,
 *    "api":{"pmid":"111","year":2005,"doi":null},"crosswalk":{"pmid":"222","year":2017,"doi":null},
 *    "rule":"own-work"|"year"|"doi"|"unresolved","winner":"111"|null}
 *       An OpenAlex id two of our papers claim, the facts, and the extract's decision.
 *   {"t":"doc","id":"us-90000001-b2","title":"...","grantDate":"YYYY-MM-DD","publicationDate":null,
 *    "filingDate":"YYYY-MM-DD","applicationId":"15127676","familyKey":"15127676","familySize":3,
 *    "assignees":["..."],"inventors":[{"first":"...","last":"..."}]}
 *       A patent document under the dataset's id. Everything but `id` may be
 *       absent: no title means the patent tables had no row.
 *   {"t":"link","pmid":"111","doc":"us-90000001-b2","score":10,"where":"front"|"body"|"both","sharedId":true}
 *       `sharedId` only when the year or DOI rule gave the paper its id.
 *
 * Env (AWS default credential chain; never hardcode keys):
 *   CURATION_BACKUP_BUCKET   the bucket `--key` is read from (set on the ETL task)
 *   AWS_DEFAULT_REGION       (default us-east-1)
 *
 * Usage:
 *   npm run etl:patent-citations:import -- --file ./patent-citations.ndjson.gz --dry-run
 *   npm run etl:patent-citations:import -- --file ./patent-citations.ndjson.gz
 *   npm run etl:patent-citations:import -- --key scratch-input/patent-citations/patent-citations.ndjson.gz
 */
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { loadExtract, readExtract } from "./load";

const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const dryRun = process.argv.includes("--dry-run");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadBytes(): Promise<Uint8Array> {
  const file = arg("--file");
  if (file) {
    console.log(`Reading ${file} ...`);
    return readFile(file);
  }
  const key = arg("--key");
  const bucket = process.env.CURATION_BACKUP_BUCKET;
  if (!key) throw new Error("Pass --file <path> or --key <s3 key>.");
  if (!bucket) throw new Error("CURATION_BACKUP_BUCKET is not set; --key needs it.");
  console.log(`Reading s3://${bucket}/${key} ...`);
  const resp = await new S3Client({ region: REGION }).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return resp.Body!.transformToByteArray();
}

/** The buffer's lines, one at a time, without a second copy of the file as a string. */
function* lines(buf: Buffer): Generator<string> {
  for (let at = 0; at < buf.length; ) {
    const end = buf.indexOf(10, at);
    yield buf.toString("utf8", at, end < 0 ? buf.length : end);
    at = (end < 0 ? buf.length : end) + 1;
  }
}

async function main(): Promise<number> {
  const start = Date.now();
  // ponytail: the whole file is held in memory (about 15 MB zipped, 85 MB
  // unzipped, plus its rows). Stream it if a release ever passes a few hundred MB.
  const extract = readExtract(lines(gunzipSync(await loadBytes())));
  const { header } = extract;
  console.log(`Extract of ${header.release}, patent tables of ${header.metadataRelease}, mapping checked ${header.mappedAt}.`);
  const summary = await loadExtract(extract, { dryRun });
  console.log(dryRun ? "DRY-RUN: no DB writes." : `Done in ${Math.round((Date.now() - start) / 1000)}s.`);
  return summary.file.links;
}

// process.exitCode (not process.exit) so the .finally cleanup still runs; the
// disconnect waits for withEtlRun's trailing etl_run write (see etl/data-sharing).
(dryRun ? main() : withEtlRun("PatentCitations-Import", main))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.write.$disconnect());
