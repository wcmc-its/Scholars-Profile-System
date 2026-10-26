/**
 * InfoEd NIH biosketches → `infoed_biosketch`, and their ORCID iDs → `orcid_candidate`
 * (source `infoed_biosketch`).
 *
 * InfoEd keeps every proposal attachment's bytes in `ProjDocVer.DocContent`. NIH
 * application packages there (`*_Egrant.pdf`, the eRA `nih_grant_image.pdf`, the
 * timestamp-named downloads, standalone biosketch uploads) contain each key person's
 * biosketch. `ProjDocVer.DocText` is NOT usable text for these — it is often the raw
 * compressed PDF — so the bytes go through `pdfToText`. Parsing and attribution live
 * in ./parse.ts.
 *
 * Proposals flagged Confidential in InfoEd (`prop_u.p_log_50 = 1`) are skipped.
 * The text is for /edit and the overview generator, never published verbatim.
 *
 * Modes:
 *  - default (weekly step): documents uploaded in the last WINDOW_DAYS. Stateless and
 *    idempotent (upsert on cwid + document version), so a Step Functions retry or a
 *    missed week inside the window loses nothing.
 *  - `--backfill`: each InfoEd person's BACKFILL_PER_PERSON newest documents (~9.4k docs,
 *    ~4h on 2026-10-25). Run once by hand on the sources family; too long for the
 *    weekly step's 4h task timeout.
 *
 * Usage: npm run etl:infoed-biosketch [-- --backfill]
 */
import { db, disconnect } from "@/lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { closeInfoedPool, getInfoedPool } from "@/lib/sources/mssql-infoed";
import { pdfToText } from "@/lib/sources/pdf-text";
import { parseBiosketches, type Person } from "./parse";

// ponytail: fixed lookback, no watermark table. Ceiling: a step dead longer than
// WINDOW_DAYS drops those uploads until the next --backfill.
const WINDOW_DAYS = 14;
const BACKFILL_PER_PERSON = 2;
const MAX_DOC_BYTES = 60_000_000;
const ORCID_SOURCE = "infoed_biosketch";

// File names that carry NIH biosketches (2026-10-25 yield sample). `*application*` /
// `*submitted*` PDFs yielded none and are left out.
const BIOSKETCH_DOC = `(v.DocFileName LIKE '%Egrant%.pdf'
  OR v.DocFileName = 'nih_grant_image.pdf'
  OR v.DocFileName LIKE '%bio%sketch%.pdf'
  OR v.DocFileName LIKE '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]%.pdf')`;

const DOC_JOINS = `FROM wc_infoedprod.dbo.ProjDocVer v
  JOIN wc_infoedprod.dbo.ProjDoc d ON d.DocID = v.DocID
  JOIN wc_infoedprod.dbo.ProjMain pm ON pm.ProjID = d.ProjId
  LEFT JOIN wc_infoedprod.dbo.prop_u pu ON pu.prop_no = pm.Prop_no AND pu.inst_code = pm.Inst_code`;

const DOC_FILTER = `${BIOSKETCH_DOC}
  AND DATALENGTH(v.DocContent) BETWEEN 1 AND ${MAX_DOC_BYTES}
  AND ISNULL(pu.p_log_50, 0) <> 1`;

type DocRef = { DocVersionID: string; Prop_no: string; Inst_code: string; UploadDate: Date };

async function listDocs(backfill: boolean): Promise<DocRef[]> {
  const pool = await getInfoedPool();
  const sql = backfill
    ? `WITH cand AS (
         SELECT v.DocVersionID, pm.Prop_no, pm.Inst_code, v.UploadDate,
           ROW_NUMBER() OVER (PARTITION BY LOWER(LTRIM(RTRIM(f.employer_id))) ORDER BY v.UploadDate DESC) rn
         ${DOC_JOINS}
         JOIN wc_infoedprod.dbo.proppds pers ON pers.prop_no = pm.Prop_no AND pers.inst_code = pm.Inst_code
         JOIN wc_infoedprod.dbo.faculty f ON f.unique_id = pers.unique_id AND f.inst_code = pers.inst_code
         WHERE ${DOC_FILTER} AND f.employer_id IS NOT NULL)
       SELECT DISTINCT DocVersionID, Prop_no, Inst_code, UploadDate FROM cand WHERE rn <= ${BACKFILL_PER_PERSON}`
    : `SELECT v.DocVersionID, pm.Prop_no, pm.Inst_code, v.UploadDate ${DOC_JOINS}
       WHERE ${DOC_FILTER} AND v.UploadDate >= DATEADD(day, -${WINDOW_DAYS}, GETDATE())`;
  return (await pool.request().query<DocRef>(sql)).recordset;
}

async function personnel(propNo: string, instCode: string): Promise<Person[]> {
  const pool = await getInfoedPool();
  const r = await pool
    .request()
    .input("p", propNo)
    .input("i", instCode)
    .query<{ cwid: string; fname: string | null; lname: string | null }>(
      `SELECT DISTINCT LOWER(LTRIM(RTRIM(f.employer_id))) cwid, f.fname, f.lname
       FROM wc_infoedprod.dbo.proppds pers
       JOIN wc_infoedprod.dbo.faculty f ON f.unique_id = pers.unique_id AND f.inst_code = pers.inst_code
       WHERE pers.prop_no = @p AND pers.inst_code = @i AND f.employer_id IS NOT NULL`,
    );
  return r.recordset.map((p) => ({ cwid: p.cwid, first: p.fname ?? "", last: p.lname ?? "" }));
}

async function docBytes(id: string): Promise<Uint8Array> {
  const pool = await getInfoedPool();
  const r = await pool
    .request()
    .input("id", id)
    .query<{ DocContent: Buffer }>(`SELECT DocContent FROM wc_infoedprod.dbo.ProjDocVer WHERE DocVersionID = @id`);
  return new Uint8Array(r.recordset[0].DocContent);
}

/** Mirror the email-attributed biosketch iDs into `orcid_candidate`, own source only. */
async function mirrorOrcidCandidates(): Promise<number> {
  const rows = await db.write.infoedBiosketch.groupBy({
    by: ["cwid", "orcid"],
    where: { attributedBy: "email", orcid: { not: null } },
    _max: { uploadedAt: true },
  });
  const now = new Date();
  for (const r of rows) {
    await db.write.orcidCandidate.upsert({
      where: { cwid_orcid_source: { cwid: r.cwid, orcid: r.orcid!, source: ORCID_SOURCE } },
      create: { cwid: r.cwid, orcid: r.orcid!, source: ORCID_SOURCE, sourceUpdatedAt: r._max.uploadedAt, syncedAt: now },
      update: { sourceUpdatedAt: r._max.uploadedAt, syncedAt: now },
    });
  }
  // Derived from our own table, so empty means nothing harvested yet, not an outage —
  // but never let an empty read wipe what is there.
  const removed = rows.length
    ? (await db.write.orcidCandidate.deleteMany({ where: { source: ORCID_SOURCE, syncedAt: { lt: now } } })).count
    : 0;
  console.log(`orcid_candidate (${ORCID_SOURCE}): ${rows.length} rows, ${removed} stale removed`);
  return rows.length;
}

async function main(): Promise<number> {
  const backfill = process.argv.includes("--backfill");
  const scholars = new Set(
    (await db.read.scholar.findMany({ select: { cwid: true } })).map((s) => s.cwid.toLowerCase()),
  );
  const docs = await listDocs(backfill);
  console.log(`${backfill ? "backfill" : `last ${WINDOW_DAYS}d`}: ${docs.length} documents`);

  const people = new Map<string, Person[]>();
  let written = 0;
  let failed = 0;
  for (const [i, doc] of docs.entries()) {
    try {
      const key = `${doc.Inst_code}|${doc.Prop_no}`;
      let kp = people.get(key);
      if (!kp) people.set(key, (kp = await personnel(doc.Prop_no, doc.Inst_code)));
      const { text } = await pdfToText(await docBytes(doc.DocVersionID));
      for (const b of parseBiosketches(text, kp)) {
        if (!scholars.has(b.cwid)) continue;
        const data = { ...b, propNo: doc.Prop_no, uploadedAt: doc.UploadDate, extractedAt: new Date() };
        await db.write.infoedBiosketch.upsert({
          where: { cwid_docVersionId: { cwid: b.cwid, docVersionId: doc.DocVersionID } },
          create: { ...data, docVersionId: doc.DocVersionID },
          update: data,
        });
        written++;
      }
    } catch (err) {
      failed++;
      console.warn(`doc ${doc.DocVersionID}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if ((i + 1) % 500 === 0) console.log(`  ${i + 1}/${docs.length} documents, ${written} biosketches`);
  }
  // A handful of unreadable PDFs is normal (5 of 9,362 in the 2026-10-25 run);
  // most of them failing means InfoEd or the parser is broken — fail the run.
  if (docs.length >= 20 && failed > docs.length / 2) {
    throw new Error(`${failed}/${docs.length} documents failed to extract`);
  }
  console.log(`infoed_biosketch: ${written} biosketches upserted from ${docs.length} documents (${failed} failed)`);
  await mirrorOrcidCandidates();
  return written;
}

if (!process.env.VITEST) {
  withEtlRun("InfoEd-Biosketch", main)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await disconnect();
      await closeInfoedPool();
    });
}
