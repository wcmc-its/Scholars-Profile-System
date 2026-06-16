/**
 * Publication-citing EXPORT (bridge) — issue #928.
 *
 * Why this exists: the publication-detail modal's "Cited by" list + total are a
 * LIVE WCM ReciterDB query (`analysis_nih_cites` joined to
 * `analysis_summary_article`, `lib/api/publication-detail.ts`) reachable from a
 * WCM-side client but NOT from the in-VPC app (the SPS↔WCM networking is not set
 * up), so on staging/prod they degrade to "Citation list temporarily
 * unavailable" (#443). This job runs WCM-side, pre-computes ONE row per CITED
 * pmid — the full NIH-cite `total` plus the same ≤500-most-recent citing-pub
 * list the modal renders — and uploads it as NDJSON to S3. The companion importer
 * (`etl:mentoring:import-citing`, run in-VPC) loads it into the env's Aurora
 * `publication_citing` table, which the read layer uses when
 * `PUBLICATION_CITING_BRIDGE=on` (import-then-flip).
 *
 * Scope: iterates the LOCAL `Publication` table pmids (the only papers the modal
 * opens) — NOT the full `(cited, citing)` edge list. The COUNT and the ≤500 list
 * are batched (one COUNT query + one window-function query per BATCH of cited
 * pmids) so the whole export is ~`2 * ceil(numPubs / BATCH)` round-trips, not one
 * per pmid. Only pmids with `total > 0` are emitted (a missing row = no NIH
 * citers, read as a genuine zero once the table is populated).
 *
 * NDJSON contract: one object per line —
 *   { pmid, total, citingPubs: [{ pmid, title, journal, year }] }
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   MENTORING_COPUBS_BUCKET  (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   PUBLICATION_CITING_KEY   (default citations/citing.ndjson; or pass --key <key>)
 *   AWS_DEFAULT_REGION       (default us-east-1)
 *   SCHOLARS_RECITERDB_*     (ReciterDB connection — see lib/sources/reciterdb.ts)
 *
 * Usage:
 *   npm run etl:mentoring:export-citing
 *   npm run etl:mentoring:export-citing -- --key citations/citing.ndjson
 *   npm run etl:mentoring:export-citing -- --dry-run   # write /tmp, skip S3
 *   npm run etl:mentoring:export-citing -- --limit 5000 # cap pmids (smoke test)
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { writeFileSync } from "node:fs";
import { db } from "../../lib/db";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";

const BUCKET =
  process.env.MENTORING_COPUBS_BUCKET ??
  process.env.ARTIFACTS_BUCKET ??
  "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";

/** Cited pmids per batched ReciterDB round-trip. */
const PMID_BATCH = 500;
/** Mirror of CITING_PUBS_CAP in lib/api/publication-detail.ts — the modal shows
 *  at most this many most-recent citers, so the bridge stores at most this many. */
const CITING_PUBS_CAP = 500;

const dryRun = process.argv.includes("--dry-run");

function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.PUBLICATION_CITING_KEY ?? "citations/citing.ndjson";
}

function resolveLimit(): number | null {
  const i = process.argv.indexOf("--limit");
  if (i < 0) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

type CitingPubItem = { pmid: number; title: string; journal: string | null; year: number | null };
type CitingRow = { pmid: number; total: number; citingPubs: CitingPubItem[] };

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const asNum = (v: number | bigint): number => (typeof v === "bigint" ? Number(v) : v);

/** Distinct numeric cited pmids from the local Publication table. */
async function loadLocalPmids(limit: number | null): Promise<number[]> {
  const rows = await db.read.publication.findMany({ select: { pmid: true } });
  const out: number[] = [];
  for (const r of rows) {
    if (!/^\d{1,16}$/.test(r.pmid)) continue;
    const n = Number(r.pmid);
    if (Number.isInteger(n) && n > 0) out.push(n);
    if (limit !== null && out.length >= limit) break;
  }
  return out;
}

/** NIH-cite COUNT per cited pmid for one batch (one round-trip). */
async function countsForBatch(citedPmids: number[]): Promise<Map<number, number>> {
  const totals = new Map<number, number>();
  if (citedPmids.length === 0) return totals;
  await withReciterConnection(async (conn) => {
    const rows = (await conn.query(
      `SELECT cited_pmid AS cited_pmid, COUNT(DISTINCT citing_pmid) AS n
         FROM analysis_nih_cites
        WHERE cited_pmid IN (${citedPmids.map(() => "?").join(",")})
        GROUP BY cited_pmid`,
      citedPmids,
    )) as { cited_pmid: number | bigint; n: number | bigint }[];
    for (const r of rows) totals.set(asNum(r.cited_pmid), asNum(r.n));
  });
  return totals;
}

/** Up to CITING_PUBS_CAP most-recent citers per cited pmid for one batch, joined
 *  to article metadata — one window-function round-trip for the whole batch.
 *  PARTITION BY cited_pmid + ROW_NUMBER caps each paper's list at the source so a
 *  single highly-cited paper can't blow up the result set. */
async function listsForBatch(
  citedPmids: number[],
): Promise<Map<number, CitingPubItem[]>> {
  const lists = new Map<number, CitingPubItem[]>();
  if (citedPmids.length === 0) return lists;
  await withReciterConnection(async (conn) => {
    const rows = (await conn.query(
      `SELECT t.cited_pmid AS cited_pmid,
              t.pmid       AS pmid,
              t.title      AS title,
              t.journal    AS journal,
              t.year       AS year
         FROM (
           SELECT c.cited_pmid AS cited_pmid,
                  a.pmid        AS pmid,
                  a.articleTitle AS title,
                  a.journalTitleVerbose AS journal,
                  a.articleYear AS year,
                  ROW_NUMBER() OVER (
                    PARTITION BY c.cited_pmid
                    ORDER BY a.publicationDateStandardized DESC, a.pmid DESC
                  ) AS rn
             FROM (SELECT DISTINCT cited_pmid, citing_pmid FROM analysis_nih_cites
                    WHERE cited_pmid IN (${citedPmids.map(() => "?").join(",")})) c
             JOIN analysis_summary_article a ON a.pmid = c.citing_pmid
         ) t
        WHERE t.rn <= ?
        ORDER BY t.cited_pmid, t.rn`,
      [...citedPmids, CITING_PUBS_CAP],
    )) as {
      cited_pmid: number | bigint;
      pmid: number | bigint;
      title: string | null;
      journal: string | null;
      year: number | null;
    }[];
    for (const r of rows) {
      const cited = asNum(r.cited_pmid);
      const list = lists.get(cited) ?? [];
      list.push({
        pmid: asNum(r.pmid),
        title: r.title ?? "",
        journal: r.journal ?? null,
        year: r.year ?? null,
      });
      lists.set(cited, list);
    }
  });
  return lists;
}

async function main() {
  const start = Date.now();
  const limit = resolveLimit();
  console.log("Loading local Publication pmids...");
  const pmids = await loadLocalPmids(limit);
  console.log(
    `${pmids.length} local pmids to probe for NIH cites${limit ? ` (--limit ${limit})` : ""}.`,
  );

  const out: CitingRow[] = [];
  let processed = 0;
  for (const batch of chunks(pmids, PMID_BATCH)) {
    // Counts first; only fetch the (heavier) list for pmids that actually have
    // citers — most pmids in a batch have zero NIH cites.
    const totals = await countsForBatch(batch);
    const cited = batch.filter((p) => (totals.get(p) ?? 0) > 0);
    const lists = cited.length > 0 ? await listsForBatch(cited) : new Map();
    for (const p of cited) {
      out.push({
        pmid: p,
        total: totals.get(p) ?? 0,
        citingPubs: lists.get(p) ?? [],
      });
    }
    processed += batch.length;
    if (processed % (PMID_BATCH * 20) === 0) {
      console.log(`  ...${processed}/${pmids.length} pmids, ${out.length} with cites so far`);
    }
  }
  console.log(`Computed ${out.length} cited pmids with ≥1 NIH cite.`);

  const ndjson = out.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const key = resolveKey();

  if (dryRun) {
    const path = "/tmp/publication-citing.ndjson";
    writeFileSync(path, ndjson, "utf-8");
    console.log(`DRY-RUN: wrote ${out.length} rows to ${path} (skipped S3 upload).`);
  } else {
    const s3 = new S3Client({ region: REGION });
    console.log(`Uploading to s3://${BUCKET}/${key} ...`);
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: ndjson,
        ContentType: "application/x-ndjson",
      }),
    );
    console.log(`Uploaded ${out.length} rows to s3://${BUCKET}/${key}.`);
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`Export complete in ${elapsed}s.`);
  if (out.length === 0) {
    console.warn(
      "WARNING: 0 cited pmids computed. Verify ReciterDB is reachable and " +
        "analysis_nih_cites is populated before trusting a clean run.",
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.read.$disconnect();
    await closeReciterPool();
  });
