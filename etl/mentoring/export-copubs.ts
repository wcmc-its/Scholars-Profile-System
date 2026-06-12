/**
 * Mentoring EXPORT (bridge) — issues #443 / #928.
 *
 * Why this exists: three mentoring surfaces in `lib/api/mentoring.ts` are
 * computed by LIVE queries against WCM ReciterDB
 * (`analysis_summary_author`/`_article`/`_author_list`, `reporting_students_mentors`,
 * `reporting_abstracts`). Those queries are reachable from a WCM-side client but
 * NOT from the in-VPC app/ETL (the SPS↔WCM networking is not set up), so on
 * staging/prod they silently degrade. This job runs WCM-side (where ReciterDB is
 * reachable), pre-computes each surface, and uploads it as NDJSON to S3. The
 * companion importers (run in-VPC) load them into the env's Aurora bridge tables,
 * which the read layer uses when `MENTORING_COPUB_BRIDGE=on` (one flag gates all
 * three surfaces; flip only AFTER the imports run — import-then-flip).
 *
 * ONE run, reusing the same ReciterDB connection + the already-loaded
 * mentor→mentee pairs, produces THREE NDJSON products:
 *
 *   1. copubs.ndjson  (#443, mentee_copublication) — per (mentor, mentee) co-pub
 *      COUNT + 3-pub preview, drives the chip badge + popover in
 *      `getMenteesForMentor`. One object per line:
 *        { mentorCwid, menteeCwid, count, preview: [{ pmid, title, journal, year }] }
 *      Only pairs with count > 0 are emitted (a 0 is the absence of a row).
 *
 *   2. aoc-mentees.ndjson  (#928, aoc_mentee) — the RAW AOC / med-student mentee
 *      LIST from `reporting_students_mentors`, drives the AOC chips in
 *      `getMenteesForMentor` + the relationship check in `getMentorMenteePair`.
 *      One object per RAW row (duplicate pairs allowed — a student repeats across
 *      programs; NOT deduped):
 *        { mentorCwid, menteeCwid, firstName, lastName, graduationYear, programType }
 *      (any of name / year / programType may be null).
 *
 *   3. copub-list.ndjson  (#928, mentee_copublication_pub) — the FULL co-pub LIST
 *      per (mentor, mentee) pair, drives the dedicated co-pubs page
 *      (/scholars/<slug>/co-pubs/<menteeCwid>) + the /co-pubs rollup via
 *      `getCoPublications`. RAW (pre-suppression — the read layer applies
 *      suppression at request time). One object per (mentor, mentee) with ≥1 pub:
 *        { mentorCwid, menteeCwid, pubs: CoPublicationFull[] }
 *
 * Mentor→mentee pairs come from the SAME three sources `getMenteesForMentor`
 * uses: `reporting_students_mentors` (ReciterDB) + `phd_mentor_relationship` +
 * `postdoc_mentor_relationship` (the env's Aurora — so run this where BOTH the
 * local Aurora has the relationship tables AND ReciterDB is reachable; the local
 * dev DB mirrors the deployed schema and is kept current by the ETLs).
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   MENTORING_COPUBS_BUCKET   (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   MENTORING_COPUBS_KEY      (default mentoring/copubs.ndjson; or pass --key <key>)
 *   MENTORING_AOC_KEY         (default mentoring/aoc-mentees.ndjson)
 *   MENTORING_COPUB_LIST_KEY  (default mentoring/copub-list.ndjson)
 *   AWS_DEFAULT_REGION        (default us-east-1)
 *   SCHOLARS_RECITERDB_*      (ReciterDB connection — see lib/sources/reciterdb.ts)
 *
 * Usage:
 *   npm run etl:mentoring:export-copubs
 *   npm run etl:mentoring:export-copubs -- --key mentoring/copubs.ndjson
 *   npm run etl:mentoring:export-copubs -- --dry-run   # write /tmp files, skip S3
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { writeFileSync } from "node:fs";
import { db } from "../../lib/db";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import type {
  CoPublication,
  CoPublicationAuthor,
  CoPublicationFull,
} from "@/lib/api/mentoring";

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

function resolveAocKey(): string {
  return process.env.MENTORING_AOC_KEY ?? "mentoring/aoc-mentees.ndjson";
}

function resolveCopubListKey(): string {
  return process.env.MENTORING_COPUB_LIST_KEY ?? "mentoring/copub-list.ndjson";
}

type ExportRow = {
  mentorCwid: string;
  menteeCwid: string;
  count: number;
  preview: CoPublication[];
};

/** One RAW `reporting_students_mentors` row destined for `aoc_mentee`. Raw =
 *  a (mentor, mentee) pair may repeat across programs; we do NOT dedup. */
type AocMenteeRow = {
  mentorCwid: string;
  menteeCwid: string;
  firstName: string | null;
  lastName: string | null;
  graduationYear: number | null;
  programType: string | null;
};

/** One line of copub-list.ndjson — the full co-pub list for a (mentor, mentee)
 *  pair that has at least one co-pub. */
type CopubListRow = {
  mentorCwid: string;
  menteeCwid: string;
  pubs: CoPublicationFull[];
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

/** Issue #928 — every RAW `reporting_students_mentors` row, for the
 *  `aoc_mentee` bridge table that backs `getMenteesForMentor`'s AOC chips +
 *  `getMentorMenteePair`'s relationship check. ONE query, raw rows (a pair
 *  repeats across programs — we do NOT dedup; the read layer collapses by
 *  CWID exactly as the live path did). */
async function loadAocMenteeRows(): Promise<AocMenteeRow[]> {
  const raw = (await withReciterConnection(async (conn) =>
    (await conn.query(
      `SELECT mentorCWID, studentCWID, studentFirstName, studentLastName,
              studentGraduationYear, programType
         FROM reporting_students_mentors
        WHERE mentorCWID IS NOT NULL AND mentorCWID != ''
          AND studentCWID IS NOT NULL AND studentCWID != ''`,
    )) as {
      mentorCWID: string;
      studentCWID: string;
      studentFirstName: string | null;
      studentLastName: string | null;
      studentGraduationYear: number | null;
      programType: string | null;
    }[],
  ).catch((err) => {
    console.error(
      "[export-copubs] reporting_students_mentors (AOC list) query failed — is ReciterDB reachable from here?",
      err,
    );
    throw err;
  }));
  return raw.map((r) => ({
    mentorCwid: r.mentorCWID.trim(),
    menteeCwid: r.studentCWID.trim(),
    firstName: r.studentFirstName ?? null,
    lastName: r.studentLastName ?? null,
    graduationYear: r.studentGraduationYear ?? null,
    programType: r.programType ?? null,
  }));
}

/** Issue #928 — the FULL co-pub list for one mentor, BATCHED across all his
 *  mentees. Mirrors `getCoPublications` (rich article+abstract query + author
 *  list) but in two round-trips for the whole mentor instead of one per mentee.
 *  RAW: suppression is NOT applied here — the read layer suppresses at request
 *  time so a later take-down doesn't require a re-export. Returns
 *  menteeCwid → CoPublicationFull[]; only mentees with ≥1 pub appear. */
async function fullCopubsForMentor(
  mentorCwid: string,
  menteeCwids: string[],
): Promise<Map<string, CoPublicationFull[]>> {
  const out = new Map<string, CoPublicationFull[]>();
  if (menteeCwids.length === 0) return out;

  await withReciterConnection(async (conn) => {
    // Query A — rich article + abstract rows per (mentee, pmid). Same columns
    // and ORDER as getCoPublications, plus a2.personIdentifier so we can fan
    // the batched result back out per mentee.
    type ArticleRow = {
      mentee_cwid: string;
      pmid: number | bigint;
      title: string | null;
      journal: string | null;
      year: number | null;
      doi: string | null;
      pmcid: string | null;
      volume: string | null;
      issue: string | null;
      pages: string | null;
      citationCount: number | null;
      abstract: string | null;
    };
    const articleRows = (await conn.query(
      `SELECT a2.personIdentifier AS mentee_cwid,
              art.pmid          AS pmid,
              art.articleTitle  AS title,
              art.journalTitleVerbose AS journal,
              art.articleYear   AS year,
              art.doi           AS doi,
              art.pmcid         AS pmcid,
              art.volume        AS volume,
              art.issue         AS issue,
              art.pages         AS pages,
              art.citationCountScopus AS citationCount,
              ra.abstractVarchar AS abstract
         FROM analysis_summary_author a1
         JOIN analysis_summary_author a2
           ON a1.pmid = a2.pmid AND a2.personIdentifier != a1.personIdentifier
         JOIN analysis_summary_article art
           ON art.pmid = a1.pmid
         LEFT JOIN reporting_abstracts ra
           ON ra.pmid = art.pmid
        WHERE a1.personIdentifier = ?
          AND a2.personIdentifier IN (${menteeCwids.map(() => "?").join(",")})
        ORDER BY a2.personIdentifier, art.articleYear DESC, art.pmid DESC`,
      [mentorCwid, ...menteeCwids],
    )) as ArticleRow[];

    if (articleRows.length === 0) return;

    // Distinct pmids across all the mentor's co-pubs for the single author-list
    // round-trip (query B).
    const pmidSet = new Set<number>();
    for (const r of articleRows) {
      pmidSet.add(typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid);
    }
    const pmids = [...pmidSet];

    // Query B — full author list for every collected pmid (one round-trip).
    type AuthorRow = {
      pmid: number | bigint;
      rank: number;
      authorLastName: string | null;
      authorFirstName: string | null;
      personIdentifier: string | null;
    };
    const authorRows = (await conn.query(
      `SELECT pmid, rank, authorLastName, authorFirstName, personIdentifier
         FROM analysis_summary_author_list
        WHERE pmid IN (${pmids.map(() => "?").join(",")})
        ORDER BY pmid, rank`,
      pmids,
    )) as AuthorRow[];

    const authorsByPmid = new Map<number, CoPublicationAuthor[]>();
    for (const r of authorRows) {
      const pmid = typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid;
      const list = authorsByPmid.get(pmid) ?? [];
      list.push({
        rank: r.rank,
        lastName: r.authorLastName ?? "",
        firstName: r.authorFirstName,
        personIdentifier: r.personIdentifier,
      });
      authorsByPmid.set(pmid, list);
    }

    for (const r of articleRows) {
      const pmid = typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid;
      const list = out.get(r.mentee_cwid) ?? [];
      list.push({
        pmid,
        title: r.title ?? "",
        journal: r.journal,
        year: r.year,
        doi: r.doi,
        pmcid: r.pmcid,
        volume: r.volume,
        issue: r.issue,
        pages: r.pages,
        citationCount: r.citationCount ?? 0,
        abstract: r.abstract ?? null,
        authors: authorsByPmid.get(pmid) ?? [],
      });
      out.set(r.mentee_cwid, list);
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
  const copubListRows: CopubListRow[] = [];
  let processed = 0;
  for (const mentorCwid of mentors) {
    const menteeCwids = [...byMentor.get(mentorCwid)!];
    // Co-pub COUNT + preview (#443 — copubs.ndjson).
    const copubs = await copubsForMentor(mentorCwid, menteeCwids);
    for (const [menteeCwid, { count, preview }] of copubs) {
      if (count > 0) exportRows.push({ mentorCwid, menteeCwid, count, preview });
    }
    // Full co-pub LIST (#928 — copub-list.ndjson). Same mentor, same pairs.
    const fullCopubs = await fullCopubsForMentor(mentorCwid, menteeCwids);
    for (const [menteeCwid, pubs] of fullCopubs) {
      if (pubs.length > 0) copubListRows.push({ mentorCwid, menteeCwid, pubs });
    }
    processed += 1;
    if (processed % 200 === 0) {
      console.log(
        `  ...${processed}/${mentors.length} mentors, ${exportRows.length} co-pub pairs / ${copubListRows.length} full-list pairs so far`,
      );
    }
  }
  console.log(
    `Computed ${exportRows.length} co-pub-count pairs (count > 0) and ${copubListRows.length} full co-pub-list pairs.`,
  );

  // AOC / med-student mentee LIST (#928 — aoc-mentees.ndjson). One query, raw rows.
  console.log("Loading AOC mentee rows (reporting_students_mentors)...");
  const aocRows = await loadAocMenteeRows();
  console.log(`Loaded ${aocRows.length} raw AOC mentee rows.`);

  const copubsNdjson = exportRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const aocNdjson = aocRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const copubListNdjson = copubListRows.map((r) => JSON.stringify(r)).join("\n") + "\n";

  const key = resolveKey();
  const aocKey = resolveAocKey();
  const copubListKey = resolveCopubListKey();

  if (dryRun) {
    const copubsPath = "/tmp/mentee-copubs.ndjson";
    const aocPath = "/tmp/aoc-mentees.ndjson";
    const copubListPath = "/tmp/copub-list.ndjson";
    writeFileSync(copubsPath, copubsNdjson, "utf-8");
    writeFileSync(aocPath, aocNdjson, "utf-8");
    writeFileSync(copubListPath, copubListNdjson, "utf-8");
    console.log(
      `DRY-RUN: wrote ${exportRows.length} co-pub rows to ${copubsPath}, ` +
        `${aocRows.length} AOC rows to ${aocPath}, ` +
        `${copubListRows.length} full-list rows to ${copubListPath} (skipped S3 upload).`,
    );
  } else {
    const s3 = new S3Client({ region: REGION });
    console.log(`Uploading to s3://${BUCKET}/${key} ...`);
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: copubsNdjson,
        ContentType: "application/x-ndjson",
      }),
    );
    console.log(`Uploading to s3://${BUCKET}/${aocKey} ...`);
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: aocKey,
        Body: aocNdjson,
        ContentType: "application/x-ndjson",
      }),
    );
    console.log(`Uploading to s3://${BUCKET}/${copubListKey} ...`);
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: copubListKey,
        Body: copubListNdjson,
        ContentType: "application/x-ndjson",
      }),
    );
    console.log(
      `Uploaded ${exportRows.length} co-pub rows to s3://${BUCKET}/${key}, ` +
        `${aocRows.length} AOC rows to s3://${BUCKET}/${aocKey}, ` +
        `${copubListRows.length} full-list rows to s3://${BUCKET}/${copubListKey}.`,
    );
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`Export complete in ${elapsed}s.`);
  if (exportRows.length === 0) {
    console.warn(
      "WARNING: 0 co-pub-count pairs computed. Verify ReciterDB is reachable and " +
        "analysis_summary_author is populated before trusting a clean run.",
    );
  }
  if (aocRows.length === 0) {
    console.warn(
      "WARNING: 0 AOC mentee rows loaded. Verify ReciterDB is reachable and " +
        "reporting_students_mentors is populated before trusting a clean run.",
    );
  }
  if (copubListRows.length === 0) {
    console.warn(
      "WARNING: 0 full co-pub-list pairs computed. Verify ReciterDB is reachable and " +
        "analysis_summary_author/_article are populated before trusting a clean run.",
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
