/**
 * Mentee co-publication EXPORT (bridge) — issue #443.
 *
 * Why this exists: `getMenteesForMentor` shows a per-mentee co-publication count
 * + 3-pub preview computed by a LIVE query against WCM ReciterDB
 * (`analysis_summary_author`/`_article`). That query is reachable from a WCM-side
 * client but NOT from the in-VPC app/ETL (the SPS↔WCM networking is not set up),
 * so on staging/prod the count silently degrades to "temporarily unavailable".
 *
 * This job runs WCM-side (where ReciterDB is reachable), pre-computes every
 * (mentor, mentee) co-pub count + preview, and uploads it as NDJSON to S3. The
 * companion importer (`etl:mentoring:import-copubs`, run in-VPC) loads it into
 * the env's Aurora `mentee_copublication` table, which the read layer uses when
 * `MENTORING_COPUB_BRIDGE=on`. Same bridge shape as the COI-statement bridge.
 *
 * Mentor→mentee pairs come from the SAME three sources `getMenteesForMentor`
 * uses: `reporting_students_mentors` (ReciterDB) + `phd_mentor_relationship` +
 * `postdoc_mentor_relationship` (the env's Aurora — so run this where BOTH the
 * local Aurora has the relationship tables AND ReciterDB is reachable; the local
 * dev DB mirrors the deployed schema and is kept current by the ETLs).
 *
 * NDJSON contract: one object per line —
 *   { mentorCwid, menteeCwid, count, preview: [{ pmid, title, journal, year }] }
 * Only pairs with count > 0 are emitted (a 0 is the absence of a row).
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   MENTORING_COPUBS_BUCKET  (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   MENTORING_COPUBS_KEY     (default mentoring/copubs.ndjson; or pass --key <key>)
 *   AWS_DEFAULT_REGION       (default us-east-1)
 *   SCHOLARS_RECITERDB_*     (ReciterDB connection — see lib/sources/reciterdb.ts)
 *
 * Usage:
 *   npm run etl:mentoring:export-copubs
 *   npm run etl:mentoring:export-copubs -- --key mentoring/copubs.ndjson
 *   npm run etl:mentoring:export-copubs -- --dry-run   # write /tmp file, skip S3
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { writeFileSync } from "node:fs";
import { db } from "../../lib/db";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import type { CoPublication } from "@/lib/api/mentoring";

const BUCKET =
  process.env.MENTORING_COPUBS_BUCKET ??
  process.env.ARTIFACTS_BUCKET ??
  "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";

const dryRun = process.argv.includes("--dry-run");

function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.MENTORING_COPUBS_KEY ?? "mentoring/copubs.ndjson";
}

type ExportRow = {
  mentorCwid: string;
  menteeCwid: string;
  count: number;
  preview: CoPublication[];
};

/** All (mentorCwid → set of menteeCwids) pairs, unioned across the three
 *  relationship sources `getMenteesForMentor` reads. */
async function loadMentorMenteePairs(): Promise<Map<string, Set<string>>> {
  const byMentor = new Map<string, Set<string>>();
  const add = (mentor?: string | null, mentee?: string | null) => {
    const m = (mentor ?? "").trim();
    const s = (mentee ?? "").trim();
    if (!m || !s || m === s) return;
    let set = byMentor.get(m);
    if (!set) {
      set = new Set<string>();
      byMentor.set(m, set);
    }
    set.add(s);
  };

  // ReciterDB AOC / Jenzabar-mirrored students.
  const aoc = (await withReciterConnection(async (conn) =>
    (await conn.query(
      `SELECT mentorCWID, studentCWID
         FROM reporting_students_mentors
        WHERE mentorCWID IS NOT NULL AND mentorCWID != ''
          AND studentCWID IS NOT NULL AND studentCWID != ''`,
    )) as { mentorCWID: string; studentCWID: string }[],
  ).catch((err) => {
    console.error(
      "[export-copubs] reporting_students_mentors query failed — is ReciterDB reachable from here?",
      err,
    );
    throw err;
  }));
  for (const r of aoc) add(r.mentorCWID, r.studentCWID);

  // Local Aurora relationship tables.
  const [phd, postdoc] = await Promise.all([
    db.read.phdMentorRelationship.findMany({ select: { mentorCwid: true, menteeCwid: true } }),
    db.read.postdocMentorRelationship.findMany({ select: { mentorCwid: true, menteeCwid: true } }),
  ]);
  for (const r of phd) add(r.mentorCwid, r.menteeCwid);
  for (const r of postdoc) add(r.mentorCwid, r.menteeCwid);

  return byMentor;
}

/** Run the live co-pub query for one mentor + his mentee CWIDs, aggregating to
 *  a count + 3-pub preview per mentee. Mirrors `getMenteesForMentor`. */
async function copubsForMentor(
  mentorCwid: string,
  menteeCwids: string[],
): Promise<Map<string, { count: number; preview: CoPublication[] }>> {
  const out = new Map<string, { count: number; preview: CoPublication[] }>();
  if (menteeCwids.length === 0) return out;
  await withReciterConnection(async (conn) => {
    const rows = (await conn.query(
      `SELECT DISTINCT a2.personIdentifier AS mentee_cwid,
              a1.pmid AS pmid,
              art.articleTitle AS title,
              art.journalTitleVerbose AS journal,
              art.articleYear AS year
         FROM analysis_summary_author a1
         JOIN analysis_summary_author a2
           ON a1.pmid = a2.pmid AND a2.personIdentifier != a1.personIdentifier
         JOIN analysis_summary_article art
           ON art.pmid = a1.pmid
        WHERE a1.personIdentifier = ?
          AND a2.personIdentifier IN (${menteeCwids.map(() => "?").join(",")})
        ORDER BY a2.personIdentifier, art.articleYear DESC, a1.pmid DESC`,
      [mentorCwid, ...menteeCwids],
    )) as {
      mentee_cwid: string;
      pmid: number | bigint;
      title: string;
      journal: string | null;
      year: number | null;
    }[];
    for (const r of rows) {
      const entry = out.get(r.mentee_cwid) ?? { count: 0, preview: [] as CoPublication[] };
      entry.count += 1;
      if (entry.preview.length < 3) {
        entry.preview.push({
          pmid: typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid,
          title: r.title,
          journal: r.journal,
          year: r.year,
        });
      }
      out.set(r.mentee_cwid, entry);
    }
  });
  return out;
}

async function main() {
  const start = Date.now();
  console.log("Loading mentor→mentee pairs (ReciterDB + Aurora relationship tables)...");
  const byMentor = await loadMentorMenteePairs();
  const mentors = [...byMentor.keys()];
  console.log(
    `${mentors.length} mentors, ${[...byMentor.values()].reduce((n, s) => n + s.size, 0)} mentor-mentee pairs.`,
  );

  const exportRows: ExportRow[] = [];
  let processed = 0;
  for (const mentorCwid of mentors) {
    const menteeCwids = [...byMentor.get(mentorCwid)!];
    const copubs = await copubsForMentor(mentorCwid, menteeCwids);
    for (const [menteeCwid, { count, preview }] of copubs) {
      if (count > 0) exportRows.push({ mentorCwid, menteeCwid, count, preview });
    }
    processed += 1;
    if (processed % 200 === 0) {
      console.log(`  ...${processed}/${mentors.length} mentors, ${exportRows.length} co-pub pairs so far`);
    }
  }
  console.log(`Computed ${exportRows.length} (mentor, mentee) co-pub pairs (count > 0).`);

  const ndjson = exportRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const key = resolveKey();

  if (dryRun) {
    const path = "/tmp/mentee-copubs.ndjson";
    writeFileSync(path, ndjson, "utf-8");
    console.log(`DRY-RUN: wrote ${exportRows.length} rows to ${path} (skipped S3 upload).`);
  } else {
    console.log(`Uploading to s3://${BUCKET}/${key} ...`);
    const s3 = new S3Client({ region: REGION });
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: ndjson,
        ContentType: "application/x-ndjson",
      }),
    );
    console.log(`Uploaded ${exportRows.length} rows to s3://${BUCKET}/${key}.`);
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`Export complete in ${elapsed}s.`);
  if (exportRows.length === 0) {
    console.warn(
      "WARNING: 0 co-pub pairs computed. Verify ReciterDB is reachable and " +
        "analysis_summary_author is populated before trusting a clean run.",
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
