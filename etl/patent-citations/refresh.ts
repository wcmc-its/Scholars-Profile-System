/**
 * Patent-citations REFRESH: the weekly step (PatentCitationsWeekly). Rebuilds
 * the extract against this environment's own publication list and loads it,
 * so papers that reach Scholars late get the patents of the current release
 * too, and a new release is picked up without anyone running anything.
 *
 *   1. Releases. Zenodo's latest version of Reliance on Science (concept
 *      3236339) and the USPTO portal's listing of the nine PatentsView tables.
 *      If a listing cannot be read, the last good one (the manifest) is used.
 *   2. Files. Each source file is cached in S3 under its checksum or release
 *      date (`scratch-input/patent-citations/raw/…`); a file not cached yet is
 *      downloaded once, checked against the listed MD5 or size, and stored.
 *   3. Extract (extract.ts). OpenAlex answers are kept in S3 (`…/state/`), so
 *      only new papers are asked.
 *   4. Load (load.ts) with pruning, then store the patent tables' "data to"
 *      date (etl_state.patent_data_to) for the report and card to print: links the new extract no longer carries
 *      are deleted, behind the drop guards. The extract is kept in S3
 *      (`…/extracts/`), so `etl:patent-citations:import -- --key …` can reload it.
 *
 * Writes `etl_run` source `PatentCitations` (weekly on Data sync).
 *
 * Env: CURATION_BACKUP_BUCKET, DATABASE_URL, OPENALEX_API_KEY,
 * USPTO_ODP_API_KEY (sent only to *.uspto.gov), AWS_DEFAULT_REGION.
 *
 * Usage:
 *   npm run etl:patent-citations:refresh              # the weekly step
 *   npm run etl:patent-citations:refresh -- --dry-run # everything but the DB writes and the manifest
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { setPatentDataTo } from "@/lib/etl-state";
import { PATENTSVIEW_TABLES, buildExtract } from "./extract";
import { loadExtract, readExtract } from "./load";

const PREFIX = "scratch-input/patent-citations";
const ZENODO_CONCEPT = "3236339"; // Reliance on Science, all versions
const ROS_FILE = "pcs_oa_uspto.csv";
const CROSSWALK = { url: "https://zenodo.org/api/records/8278104/files/paperpmid.zip/content", md5: "abcc50eb83cbae18a588024ec56aea7a" };
const PV_PRODUCTS = ["PVGPATDIS", "PVPGPUBDIS"]; // granted, pre-grant
const UA = "research-script/1.0";
const dryRun = process.argv.includes("--dry-run");
const s3 = new S3Client({ region: process.env.AWS_DEFAULT_REGION ?? "us-east-1" });

type SourceFile = { name: string; url: string; key: string; size?: number; md5?: string };
export type Manifest = {
  release: string;
  /** PatentsView release date and the date its data runs to, "YYYY-MM-DD". */
  metadataRelease: string;
  metadataDataTo: string;
  files: SourceFile[];
  loadedAt?: string;
};

function bucket(): string {
  const b = process.env.CURATION_BACKUP_BUCKET;
  if (!b) throw new Error("CURATION_BACKUP_BUCKET is not set.");
  return b;
}

/** An S3 object, or null when it is not there (the role cannot list, so a missing key answers 403). */
async function s3Get(key: string): Promise<Readable | null> {
  try {
    return (await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }))).Body as Readable;
  } catch (e) {
    const code = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (code === 403 || code === 404) return null;
    throw e;
  }
}
async function s3Put(key: string, path: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: createReadStream(path), ContentLength: statSync(path).size }));
}

const isUspto = (u: string) => {
  const url = new URL(u);
  return url.protocol === "https:" && (url.hostname === "uspto.gov" || url.hostname.endsWith(".uspto.gov"));
};
/** GET, following redirects by hand so the USPTO key goes only to *.uspto.gov. */
async function get(url: string): Promise<Response> {
  for (let hop = 0; hop < 5; hop++) {
    const headers: Record<string, string> = { "User-Agent": UA };
    if (isUspto(url)) {
      const key = process.env.USPTO_ODP_API_KEY;
      if (!key) throw new Error("USPTO_ODP_API_KEY is not set.");
      headers["X-API-KEY"] = key;
    }
    const r = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(60 * 60_000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      url = new URL(r.headers.get("location")!, url).toString();
      continue;
    }
    if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
    return r;
  }
  throw new Error("too many redirects");
}

/** The releases the sources list now. */
export async function listReleases(): Promise<Manifest> {
  const z = (await (await get(`https://zenodo.org/api/records/${ZENODO_CONCEPT}/versions/latest`)).json()) as {
    id: number;
    files: Array<{ key: string; size: number; checksum: string; links: { self: string } }>;
  };
  const ros = z.files.find((f) => f.key === ROS_FILE);
  if (!ros) throw new Error(`Zenodo record ${z.id} has no ${ROS_FILE}.`);
  const md5 = ros.checksum.replace(/^md5:/, "");
  const files: SourceFile[] = [
    { name: ROS_FILE, url: ros.links.self, key: `${PREFIX}/raw/ros/${md5}/${ROS_FILE}`, size: ros.size, md5 },
    { name: "paperpmid.zip", url: CROSSWALK.url, key: `${PREFIX}/raw/crosswalk/paperpmid.zip`, md5: CROSSWALK.md5 },
  ];
  const listed = new Map<string, { fileSize: number; fileDownloadURI: string; fileReleaseDate: string; fileDataToDate: string }>();
  for (const p of PV_PRODUCTS) {
    const d = (await (await get(`https://api.uspto.gov/api/v1/datasets/products/${p}`)).json()) as {
      bulkDataProductBag: Array<{ productFileBag: { fileDataBag: Array<{ fileName: string; fileSize: number; fileDownloadURI: string; fileReleaseDate: string; fileDataToDate: string }> } }>;
    };
    for (const f of d.bulkDataProductBag[0].productFileBag.fileDataBag) listed.set(f.fileName, f);
  }
  const pv = PATENTSVIEW_TABLES.map((t) => {
    const f = listed.get(`${t}.tsv.zip`);
    if (!f) throw new Error(`The USPTO listing has no ${t}.tsv.zip.`);
    return f;
  });
  const metadataRelease = pv.map((f) => f.fileReleaseDate.slice(0, 10)).sort().at(-1)!;
  const metadataDataTo = pv.map((f) => f.fileDataToDate.slice(0, 10)).sort()[0];
  pv.forEach((f, i) =>
    files.push({ name: `${PATENTSVIEW_TABLES[i]}.tsv.zip`, url: f.fileDownloadURI, key: `${PREFIX}/raw/pv/${f.fileReleaseDate.slice(0, 10)}/${PATENTSVIEW_TABLES[i]}.tsv.zip`, size: f.fileSize }),
  );
  return { release: `zenodo:${z.id}`, metadataRelease, metadataDataTo, files };
}

/** A source file on local disk: from the S3 cache, else downloaded, checked and cached. */
async function fetchFile(f: SourceFile, dir: string): Promise<string> {
  const path = join(dir, f.name);
  const check = async () => {
    if (f.size !== undefined && statSync(path).size !== f.size) return `size ${statSync(path).size}, listed ${f.size}`;
    if (f.md5) {
      const h = createHash("md5");
      for await (const b of createReadStream(path)) h.update(b as Buffer);
      if (h.digest("hex") !== f.md5) return "MD5 differs from the listing";
    }
    return null;
  };
  const cached = await s3Get(f.key);
  if (cached) {
    await pipeline(cached, createWriteStream(path));
    const bad = await check();
    if (!bad) return path;
    console.warn(`Cached ${f.key} is bad (${bad}); downloading it again.`);
  }
  console.log(`Downloading ${f.name} from ${new URL(f.url).hostname} ...`);
  const r = await get(f.url);
  await pipeline(Readable.fromWeb(r.body as never), createWriteStream(path));
  const bad = await check();
  if (bad) throw new Error(`${f.name}: ${bad}. Nothing loaded.`);
  await s3Put(f.key, path);
  return path;
}

const STATE_FILES = ["oa_map.tsv", "oa_asked.txt", "oa_asked_other.txt", "tiebreak_api.json"];

async function main(): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), "patent-refresh-"));
  try {
    let m: Manifest;
    try {
      m = await listReleases();
    } catch (e) {
      const last = await s3Get(`${PREFIX}/manifest.json`);
      if (!last) throw e;
      console.warn(`Release listing failed (${(e as Error).message}); using the last manifest.`);
      m = JSON.parse(Buffer.concat(await last.toArray()).toString("utf8")) as Manifest;
    }
    console.log(`Dataset ${m.release}; patent tables of ${m.metadataRelease}, data to ${m.metadataDataTo}.`);
    const local = new Map<string, string>();
    for (const f of m.files) local.set(f.name, await fetchFile(f, work));

    const state = join(work, "state");
    mkdirSync(state);
    for (const f of STATE_FILES) {
      const body = await s3Get(`${PREFIX}/state/${f}`);
      if (body) await pipeline(body, createWriteStream(join(state, f)));
    }
    const corpus = (await db.read.publication.findMany({ select: { pmid: true, year: true, doi: true } })).map((r) => ({ key: r.pmid, year: r.year, doi: r.doi }));
    const out = join(work, "patent-citations.ndjson.gz");
    await buildExtract({
      ros: local.get(ROS_FILE)!,
      crosswalk: local.get("paperpmid.zip")!,
      pv: work,
      state,
      corpus,
      release: m.release,
      metadataRelease: m.metadataRelease,
      mappedAt: new Date().toISOString().slice(0, 10),
      out,
    });
    // OpenAlex answers are worth keeping even when a guard refuses the load.
    for (const f of readdirSync(state)) await s3Put(`${PREFIX}/state/${f}`, join(state, f));
    const today = new Date().toISOString().slice(0, 10);
    await s3Put(`${PREFIX}/extracts/${today}.ndjson.gz`, out);

    const extract = readExtract(gunzipSync(readFileSync(out)).toString("utf8").split("\n"));
    const summary = await loadExtract(extract, { dryRun, prune: true });
    if (!dryRun) {
      await setPatentDataTo(m.metadataDataTo);
      const tmp = join(work, "manifest.json");
      writeFileSync(tmp, JSON.stringify({ ...m, loadedAt: new Date().toISOString() }, null, 2));
      await s3Put(`${PREFIX}/manifest.json`, tmp);
    }
    console.log(dryRun ? "DRY-RUN: no DB writes, manifest unchanged." : "Done.");
    return summary.file.links;
  } finally {
    if (existsSync(work)) rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("refresh.ts")) {
  (dryRun ? main() : withEtlRun("PatentCitations", main))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => Promise.all([db.write.$disconnect(), db.read.$disconnect()]));
}
