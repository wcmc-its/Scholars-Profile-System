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
 * mentor→mentee pairs, produces FOUR NDJSON products:
 *
 *   1. copubs.ndjson  (#443, mentee_copublication) — per (mentor, mentee) co-pub
 *      COUNT + 3-pub preview, drives the chip badge + popover in
 *      `getMenteesForMentor`. One object per line:
 *        { mentorCwid, menteeCwid, count, preview: [{ id, pmid, title, journal, year }] }
 *      Only pairs with count > 0 are emitted (a 0 is the absence of a row).
 *
 *   2. aoc-mentees.ndjson  (#928, aoc_mentee) — the RAW AOC / med-student mentee
 *      LIST from `reporting_students_mentors`, drives the AOC chips in
 *      `getMenteesForMentor` + the relationship check in `getMentorMenteePair`.
 *      One object per RAW row (duplicate pairs allowed — a student repeats across
 *      programs; NOT deduped):
 *        { mentorCwid, menteeCwid, firstName, lastName, graduationYear, entryYear,
 *          programType, mentorFirstName, mentorLastName }
 *      (any of name / year / entryYear / programType / mentor name may be null).
 *      `entryYear` is `studentEntryYear` — the program ENTRY year the Mentored
 *      publications report (`/edit/reports/7`) needs for its "in program window"
 *      rule. `mentorFirstName` / `mentorLastName` are the roster's own mentor
 *      name, which the same report shows for a mentor with no Scholar row.
 *
 *   3. copub-list.ndjson  (#928, mentee_copublication_pub) — the FULL co-pub LIST
 *      per (mentor, mentee) pair, drives the dedicated co-pubs page
 *      (/scholars/<slug>/co-pubs/<menteeCwid>) + the /co-pubs rollup via
 *      `getCoPublications`. RAW (pre-suppression — the read layer applies
 *      suppression at request time). One object per (mentor, mentee) with ≥1 pub:
 *        { mentorCwid, menteeCwid, pubs: CoPublicationFull[] }
 *
 *   4. learner-pubs.ndjson  (aoc_mentee_publication) — EVERY ReCiter-attributed
 *      publication of every distinct `reporting_students_mentors.studentCWID`
 *      (all program types), mentor or no mentor on the byline, for the Mentored
 *      publications report's "All learner publications" mode (MD learners are
 *      not Scholar rows, so their full lists exist only here). Same
 *      `CoPublicationFull` shape and the SAME article/author-list builder as
 *      product 3 (`hydrateArticles`), so the co-pub set is a strict subset by
 *      pmid. One object per learner with ≥1 pub:
 *        { menteeCwid, pubs: CoPublicationFull[] }
 *
 * Every publication row carries `id` (round 5) next to `pmid`: the SPS
 * `Publication.pmid` key — the pmid as digits for a PubMed article, the
 * source-prefixed `analysis_summary_article.article_id` (`SCOPUS:…`) for a
 * Scopus-only one, whose ReciterDB `pmid` is a synthetic negative that churns
 * nightly. The importers key their tables on `id` (falling back to a positive
 * `pmid` for a product written before round 5).
 *
 * Mentor→mentee pairs come from THREE sources: `reporting_students_mentors`
 * (ReciterDB) + `phd_mentor_relationship` + `postdoc_mentor_relationship` (the
 * env's Aurora — so run this where BOTH the local Aurora has the relationship
 * tables AND ReciterDB is reachable; the local dev DB mirrors the deployed
 * schema and is kept current by the ETLs).
 *
 * Keep that list in lockstep with `getMenteesForMentor`. Where
 * MENTORING_COPUB_BRIDGE is on, these products are the app's ONLY co-pub source,
 * so a source the read path renders but this export skips shows up as a silent,
 * indistinguishable-from-real zero on every co-pub surface.
 *
 * The ONE deliberate exception is the `manualMentees` field-override (#2011).
 * A hand-entered mentee is resolved at READ TIME from the env's own Aurora, and
 * `getMenteesForMentor` / `getCoPublications` compute its co-pubs there — never
 * from these products. It is intentionally NOT a pair source here; do not add it
 * back. Doing so gives those pairs two sources that drift apart, and the export
 * cannot be run from anywhere that has both the field-override rows and
 * ReciterDB in reach anyway.
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   MENTORING_COPUBS_BUCKET   (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   MENTORING_COPUBS_KEY      (default mentoring/copubs.ndjson; or pass --key <key>)
 *   MENTORING_AOC_KEY         (default mentoring/aoc-mentees.ndjson)
 *   MENTORING_COPUB_LIST_KEY  (default mentoring/copub-list.ndjson)
 *   MENTORING_LEARNER_PUBS_KEY (default mentoring/learner-pubs.ndjson)
 *   AWS_DEFAULT_REGION        (default us-east-1)
 *   SCHOLARS_RECITERDB_*      (ReciterDB connection — see lib/sources/reciterdb.ts)
 *
 * Usage:
 *   npm run etl:mentoring:export-copubs
 *   npm run etl:mentoring:export-copubs -- --key mentoring/copubs.ndjson
 *   npm run etl:mentoring:export-copubs -- --dry-run   # write /tmp files, skip S3
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { PoolConnection } from "mariadb";
import { writeFileSync } from "node:fs";
import { db, disconnect } from "../../lib/db";
import { pubKey } from "@/lib/pub-key";
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

function resolveLearnerPubsKey(): string {
  return process.env.MENTORING_LEARNER_PUBS_KEY ?? "mentoring/learner-pubs.ndjson";
}

/** Learners per `analysis_summary_author` IN-list round-trip for product 4. */
const LEARNER_BATCH = 200;

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
  /** `reporting_students_mentors.studentEntryYear` — nullable at the source. */
  entryYear: number | null;
  programType: string | null;
  /** `reporting_students_mentors.mentorFirstName` / `mentorLastName` — the
   *  roster's own mentor name, nullable at the source. */
  mentorFirstName: string | null;
  mentorLastName: string | null;
};

/** One line of learner-pubs.ndjson — every ReCiter-attributed publication of
 *  one learner (product 4), only emitted when there is at least one. */
type LearnerPubsRow = {
  menteeCwid: string;
  pubs: CoPublicationFull[];
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
              art.article_id AS article_id,
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
      article_id: string | null;
      title: string;
      journal: string | null;
      year: number | null;
    }[];
    for (const r of rows) {
      const entry = out.get(r.mentee_cwid) ?? { count: 0, preview: [] as CoPublication[] };
      entry.count += 1;
      if (entry.preview.length < 3) {
        const pmid = typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid;
        entry.preview.push({
          id: pubKey(pmid, r.article_id),
          pmid,
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
              studentGraduationYear, studentEntryYear, programType,
              mentorFirstName, mentorLastName
         FROM reporting_students_mentors
        WHERE mentorCWID IS NOT NULL AND mentorCWID != ''
          AND studentCWID IS NOT NULL AND studentCWID != ''`,
    )) as {
      mentorCWID: string;
      studentCWID: string;
      studentFirstName: string | null;
      studentLastName: string | null;
      studentGraduationYear: number | null;
      studentEntryYear: number | null;
      programType: string | null;
        mentorFirstName: string | null;
        mentorLastName: string | null;
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
    entryYear: r.studentEntryYear ?? null,
    programType: r.programType ?? null,
    mentorFirstName: r.mentorFirstName?.trim() || null,
    mentorLastName: r.mentorLastName?.trim() || null,
  }));
}

/** One rich article + abstract row as `ARTICLE_SELECT` returns it, keyed to
 *  the learner it was fetched for (`mentee_cwid`) so a batched result fans
 *  back out per learner. Shared by products 3 and 4. */
type ArticleRow = {
  mentee_cwid: string;
  pmid: number | bigint;
  article_id: string | null;
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

/** The `CoPublicationFull` column list (same columns and aliases as
 *  `getCoPublications`). `a2` is the alias of the `analysis_summary_author`
 *  row that names the learner; the caller supplies the FROM/WHERE. */
const ARTICLE_SELECT = `SELECT a2.personIdentifier AS mentee_cwid,
              art.pmid          AS pmid,
              art.article_id    AS article_id,
              art.articleTitle  AS title,
              art.journalTitleVerbose AS journal,
              art.articleYear   AS year,
              art.doi           AS doi,
              art.pmcid         AS pmcid,
              art.volume        AS volume,
              art.issue         AS issue,
              art.pages         AS pages,
              art.citationCountScopus AS citationCount,
              ra.abstractVarchar AS abstract`;

/** Query B — the full author list for every pmid in `articleRows` (ONE
 *  round-trip), then assemble `CoPublicationFull` per row and group by
 *  `mentee_cwid`. The one builder behind copub-list.ndjson AND
 *  learner-pubs.ndjson, so the two products can't drift in shape. */
async function hydrateArticles(
  conn: PoolConnection,
  articleRows: ArticleRow[],
): Promise<Map<string, CoPublicationFull[]>> {
  const out = new Map<string, CoPublicationFull[]>();
  if (articleRows.length === 0) return out;

  const pmidSet = new Set<number>();
  for (const r of articleRows) {
    pmidSet.add(typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid);
  }
  const pmids = [...pmidSet];

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
      id: pubKey(pmid, r.article_id),
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
  return out;
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
  if (menteeCwids.length === 0) return new Map();
  return withReciterConnection(async (conn) => {
    // Query A — rich article + abstract rows per (mentee, pmid), where the
    // mentor (a1) and the mentee (a2) are both attributed authors.
    const articleRows = (await conn.query(
      `${ARTICLE_SELECT}
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
    return hydrateArticles(conn, articleRows);
  });
}

/** Product 4 — EVERY ReCiter-attributed publication of each learner in
 *  `learnerCwids` (one batch; the caller chunks by `LEARNER_BATCH`), no
 *  mentor condition. Same column list and author-list hydration as
 *  `fullCopubsForMentor`, so a co-pub row and its learner-pubs row are
 *  byte-identical for the same pmid. Returns menteeCwid → CoPublicationFull[];
 *  only learners with ≥1 pub appear. */
async function allPubsForLearners(
  learnerCwids: string[],
): Promise<Map<string, CoPublicationFull[]>> {
  if (learnerCwids.length === 0) return new Map();
  return withReciterConnection(async (conn) => {
    const articleRows = (await conn.query(
      `${ARTICLE_SELECT}
         FROM analysis_summary_author a2
         JOIN analysis_summary_article art
           ON art.pmid = a2.pmid
         LEFT JOIN reporting_abstracts ra
           ON ra.pmid = art.pmid
        WHERE a2.personIdentifier IN (${learnerCwids.map(() => "?").join(",")})
        ORDER BY a2.personIdentifier, art.articleYear DESC, art.pmid DESC`,
      learnerCwids,
    )) as ArticleRow[];
    return hydrateArticles(conn, articleRows);
  });
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

  // Every learner's FULL publication list (learner-pubs.ndjson). The learner
  // set is every distinct studentCWID the roster carries, all program types —
  // NOT only the pairs that have a co-pub.
  const learnerCwids = [...new Set(aocRows.map((r) => r.menteeCwid))];
  console.log(`Loading all publications for ${learnerCwids.length} distinct learners...`);
  const learnerPubsRows: LearnerPubsRow[] = [];
  let learnerPubCount = 0;
  for (let i = 0; i < learnerCwids.length; i += LEARNER_BATCH) {
    const batch = learnerCwids.slice(i, i + LEARNER_BATCH);
    const pubsByLearner = await allPubsForLearners(batch);
    for (const [menteeCwid, pubs] of pubsByLearner) {
      if (pubs.length === 0) continue;
      learnerPubsRows.push({ menteeCwid, pubs });
      learnerPubCount += pubs.length;
    }
    if ((i / LEARNER_BATCH + 1) % 5 === 0 || i + LEARNER_BATCH >= learnerCwids.length) {
      console.log(
        `  ...${Math.min(i + LEARNER_BATCH, learnerCwids.length)}/${learnerCwids.length} learners, ` +
          `${learnerPubsRows.length} with ≥1 pub / ${learnerPubCount} pubs so far`,
      );
    }
  }
  console.log(
    `Computed ${learnerPubsRows.length} learners with ≥1 publication (${learnerPubCount} publications).`,
  );

  const copubsNdjson = exportRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const aocNdjson = aocRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const copubListNdjson = copubListRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const learnerPubsNdjson = learnerPubsRows.map((r) => JSON.stringify(r)).join("\n") + "\n";

  const key = resolveKey();
  const aocKey = resolveAocKey();
  const copubListKey = resolveCopubListKey();
  const learnerPubsKey = resolveLearnerPubsKey();

  if (dryRun) {
    const copubsPath = "/tmp/mentee-copubs.ndjson";
    const aocPath = "/tmp/aoc-mentees.ndjson";
    const copubListPath = "/tmp/copub-list.ndjson";
    const learnerPubsPath = "/tmp/learner-pubs.ndjson";
    writeFileSync(copubsPath, copubsNdjson, "utf-8");
    writeFileSync(aocPath, aocNdjson, "utf-8");
    writeFileSync(copubListPath, copubListNdjson, "utf-8");
    writeFileSync(learnerPubsPath, learnerPubsNdjson, "utf-8");
    console.log(
      `DRY-RUN: wrote ${exportRows.length} co-pub rows to ${copubsPath}, ` +
        `${aocRows.length} AOC rows to ${aocPath}, ` +
        `${copubListRows.length} full-list rows to ${copubListPath}, ` +
        `${learnerPubsRows.length} learner-pubs rows to ${learnerPubsPath} (skipped S3 upload).`,
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
    console.log(`Uploading to s3://${BUCKET}/${learnerPubsKey} ...`);
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: learnerPubsKey,
        Body: learnerPubsNdjson,
        ContentType: "application/x-ndjson",
      }),
    );
    console.log(
      `Uploaded ${exportRows.length} co-pub rows to s3://${BUCKET}/${key}, ` +
        `${aocRows.length} AOC rows to s3://${BUCKET}/${aocKey}, ` +
        `${copubListRows.length} full-list rows to s3://${BUCKET}/${copubListKey}, ` +
        `${learnerPubsRows.length} learner-pubs rows to s3://${BUCKET}/${learnerPubsKey}.`,
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
  if (learnerPubsRows.length === 0) {
    console.warn(
      "WARNING: 0 learner-pubs rows computed. Verify ReciterDB is reachable and " +
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
    await disconnect();
    await closeReciterPool();
  });
