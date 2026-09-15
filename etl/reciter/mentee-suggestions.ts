/**
 * #2634 — nightly builder for `mentee_suggestion`: co-authorship-derived
 * mentee suggestions for the mentor's /edit "Mentees › From your publications"
 * sub-view. Runs at the end of `etl/reciter/index.ts` (best-effort) and
 * standalone via `npm run etl:reciter:mentee-suggestions`.
 *
 * Source is ReCiterDB's `analysis_summary_author_list` (EVERY author of every
 * tracked pub, `personIdentifier = ''` when unmatched), self-joined mentee ×
 * mentor on pmid. TRUE last author = rank == MAX(rank) per pmid over that
 * table (`analysis_summary_author.authorPosition` is often NULL, so never it).
 *
 *   mentor  = personType 'academic-faculty-weillfulltime'
 *   mentee  = any matched author who is NOT full-time, NOT professor-ranked
 *             (assistant/associate/full, now or in an expired ED faculty SOR
 *             record via `former_professor`), NOT an SPS full-time scholar,
 *             and not an external-institution test identity (`ucsf_…`: any
 *             `_` in the identifier — WCM CWIDs never carry one)
 *   window  = articleYear >= runYear - 8 for everything counted or listed
 *   keep    = nCoPubs >= 2 OR nMentorLastAuthor >= 1
 *   strong  = the mentee's top faculty co-author by last-author count, with
 *             >= 2 last-author co-pubs and >= 2x the runner-up
 *
 * Writes UPSERT on (mentor, mentee) and never touch the dismissed_* columns;
 * the prune of stale pairs is volume-guarded and refuses an empty fresh set.
 */
import type { PoolConnection } from "mariadb";
import { db, disconnect } from "@/lib/db";
import { assertPruneVolume } from "@/lib/etl-guard";
import {
  classifyMenteeKind,
  tierOf,
  type MenteeKind,
  type MenteeTier,
} from "@/lib/mentee-suggestions/kind";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";

export const WINDOW_YEARS = 8;
export const PER_MENTOR_CAP = 50;
const EVIDENCE_CAP = 50;
const IN_BATCH = 500;
const MENTOR_BATCH = 200;
const UPSERT_BATCH = 50;

const FULL_TIME_TYPE = "academic-faculty-weillfulltime";
const PROFESSOR_TYPES = [
  "academic-faculty-assistant",
  "academic-faculty-associate",
  "academic-faculty-fullprofessor",
];

export type PairStats = {
  menteeCwid: string;
  mentorCwid: string;
  nCoPubs: number;
  nMentorLastAuthor: number;
  nMenteeFirstAuthor: number;
  firstYear: number | null;
  lastYear: number | null;
};

export type RankedPair = PairStats & { strong: boolean };

export type Evidence = {
  id: string;
  year: number | null;
  menteeRank: number;
  mentorRank: number;
  total: number;
};

export type SuggestionRow = {
  mentorCwid: string;
  menteeCwid: string;
  menteeName: string;
  menteeTitle: string | null;
  menteeUnit: string | null;
  kind: MenteeKind;
  tier: MenteeTier;
  nCoPubs: number;
  nMentorLastAuthor: number;
  nMenteeFirstAuthor: number;
  firstYear: number | null;
  lastYear: number | null;
  menteeFirstPublishedYear: number | null;
  strong: boolean;
  evidence: Evidence[];
  computedAt: Date;
};

export type Summary = {
  pairs: number;
  rows: number;
  strong: number;
  droppedByCap: number;
  upserted: number;
  pruned: number;
  ms: number;
};

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const pairKey = (mentorCwid: string, menteeCwid: string) => `${mentorCwid}:${menteeCwid}`;

/** SPS `Publication.pmid` key for a ReCiterDB article — mirrors `pubKey` in
 *  etl/reciter/index.ts: external rows key on the stable source-prefixed
 *  article_id (their synthetic negative pmid churns nightly), PubMed rows on
 *  the pmid. */
export function pubKey(pmid: number, articleId: string | null): string {
  return articleId != null && articleId.length <= 32 ? articleId : String(pmid);
}

/** Q1 — the heavy aggregation, in SQL. Shared with the Phase 0 probe, which
 *  passes the ground-truth mentee set. */
export async function queryPairStats(
  conn: PoolConnection,
  opts: { minYear: number; menteeCwids?: string[] },
): Promise<PairStats[]> {
  const params: unknown[] = [opts.minYear, FULL_TIME_TYPE];
  let menteeFilter = "";
  if (opts.menteeCwids) {
    menteeFilter = "AND me.personIdentifier IN (?)";
    params.push(opts.menteeCwids);
  }
  // ponytail: 2 duplicate (pmid, personIdentifier) rows exist in the 547k
  // matched rows; COUNT(DISTINCT) covers nCoPubs, the SUMs may over-count by 1.
  const rows = (await conn.query(
    `SELECT me.personIdentifier AS menteeCwid, mt.personIdentifier AS mentorCwid,
            COUNT(DISTINCT me.pmid) AS nCoPubs,
            SUM(mt.\`rank\` = mx.maxRank) AS nMentorLastAuthor,
            SUM(me.\`rank\` = 1) AS nMenteeFirstAuthor,
            MIN(a.articleYear) AS firstYear, MAX(a.articleYear) AS lastYear
       FROM analysis_summary_author_list me
       JOIN analysis_summary_article a ON a.pmid = me.pmid AND a.articleYear >= ?
       JOIN analysis_summary_author_list mt
         ON mt.pmid = me.pmid AND mt.personIdentifier <> '' AND mt.personIdentifier <> me.personIdentifier
       JOIN (SELECT pmid, MAX(\`rank\`) AS maxRank FROM analysis_summary_author_list GROUP BY pmid) mx
         ON mx.pmid = me.pmid
      WHERE me.personIdentifier <> ''
        AND LOCATE('_', me.personIdentifier) = 0
        AND EXISTS (SELECT 1 FROM person_person_type ft
                     WHERE ft.personIdentifier = mt.personIdentifier AND ft.personType = ?)
        ${menteeFilter}
      GROUP BY me.personIdentifier, mt.personIdentifier
     HAVING nCoPubs >= 2 OR nMentorLastAuthor >= 1`,
    params,
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    menteeCwid: String(r.menteeCwid),
    mentorCwid: String(r.mentorCwid),
    nCoPubs: Number(r.nCoPubs),
    nMentorLastAuthor: Number(r.nMentorLastAuthor),
    nMenteeFirstAuthor: Number(r.nMenteeFirstAuthor),
    firstYear: r.firstYear == null ? null : Number(r.firstYear),
    lastYear: r.lastYear == null ? null : Number(r.lastYear),
  }));
}

/** Candidate order within one mentee: most last-author co-pubs, then most co-pubs. */
export function byMentorStrength(a: PairStats, b: PairStats): number {
  return b.nMentorLastAuthor - a.nMentorLastAuthor || b.nCoPubs - a.nCoPubs;
}

/** The 88%-precision rule (issue #2634): >= 2 last-author co-pubs and >= 2x the runner-up. */
export function isStrong(top: PairStats, runnerUp: PairStats | undefined): boolean {
  return (
    top.nMentorLastAuthor >= 2 && top.nMentorLastAuthor >= 2 * (runnerUp?.nMentorLastAuthor ?? 0)
  );
}

/** Pure: flag each mentee's strong mentor, then cap each mentor's list. */
export function rankPairs(
  pairs: PairStats[],
  cap = PER_MENTOR_CAP,
): { rows: RankedPair[]; droppedByCap: number } {
  const byMentee = new Map<string, PairStats[]>();
  for (const p of pairs) {
    const list = byMentee.get(p.menteeCwid) ?? [];
    list.push(p);
    byMentee.set(p.menteeCwid, list);
  }
  const byMentor = new Map<string, RankedPair[]>();
  for (const list of byMentee.values()) {
    list.sort(byMentorStrength);
    list.forEach((p, i) => {
      const row = { ...p, strong: i === 0 && isStrong(p, list[1]) };
      const mentorList = byMentor.get(p.mentorCwid) ?? [];
      mentorList.push(row);
      byMentor.set(p.mentorCwid, mentorList);
    });
  }
  const rows: RankedPair[] = [];
  let droppedByCap = 0;
  for (const list of byMentor.values()) {
    list.sort((a, b) => Number(b.strong) - Number(a.strong) || byMentorStrength(a, b));
    rows.push(...list.slice(0, cap));
    droppedByCap += Math.max(0, list.length - cap);
  }
  return { rows, droppedByCap };
}

type SuggestionClient = Pick<typeof db.write, "menteeSuggestion">;

/** Upsert the fresh set (never touching dismissed_*), then prune stale pairs
 *  behind the volume guard. An empty fresh set is a failed read, not a wipe. */
export async function writeSuggestions(
  rows: SuggestionRow[],
  client: SuggestionClient = db.write,
): Promise<{ upserted: number; pruned: number }> {
  if (rows.length === 0) {
    throw new Error(
      "[mentee-suggestions] fresh set is empty (ReCiterDB read returned no pairs) — refusing to prune mentee_suggestion",
    );
  }
  const existing = await client.menteeSuggestion.findMany({
    select: { id: true, mentorCwid: true, menteeCwid: true },
  });
  const fresh = new Set(rows.map((r) => pairKey(r.mentorCwid, r.menteeCwid)));
  const staleIds = existing
    .filter((e) => !fresh.has(pairKey(e.mentorCwid, e.menteeCwid)))
    .map((e) => e.id);
  assertPruneVolume("mentee_suggestion", {
    pruning: staleIds.length,
    of: existing.length,
    maxPct: 20,
  });

  for (const batch of chunks(rows, UPSERT_BATCH)) {
    await Promise.all(
      batch.map((row) =>
        client.menteeSuggestion.upsert({
          where: {
            mentorCwid_menteeCwid: { mentorCwid: row.mentorCwid, menteeCwid: row.menteeCwid },
          },
          create: row,
          update: row, // SuggestionRow carries no dismissed_* field by construction
        }),
      ),
    );
  }
  for (const batch of chunks(staleIds, IN_BATCH)) {
    await client.menteeSuggestion.deleteMany({ where: { id: { in: batch } } });
  }
  return { upserted: rows.length, pruned: staleIds.length };
}

type PersonRow = {
  personIdentifier: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  primaryOrganizationalUnit: string | null;
};

export async function buildMenteeSuggestions(): Promise<Summary> {
  const start = Date.now();
  const now = new Date();
  const minYear = now.getFullYear() - WINDOW_YEARS;
  const log = (msg: string) => console.log(`[mentee-suggestions] ${msg}`);

  // 1. Pairs (SQL aggregate) + exclusion sets.
  const pairs = await withReciterConnection((conn) => queryPairStats(conn, { minYear }));
  log(`${pairs.length} candidate pairs (articleYear >= ${minYear}) in ${Date.now() - start}ms`);

  const excluded = new Set<string>();
  await withReciterConnection(async (conn) => {
    const rows = (await conn.query(
      `SELECT DISTINCT personIdentifier FROM person_person_type WHERE personType IN (?)`,
      [[FULL_TIME_TYPE, ...PROFESSOR_TYPES]],
    )) as Array<{ personIdentifier: string }>;
    for (const r of rows) excluded.add(r.personIdentifier);
  });
  const spsFaculty = await db.write.scholar.findMany({
    where: { roleCategory: "full_time_faculty" },
    select: { cwid: true },
  });
  for (const s of spsFaculty) excluded.add(s.cwid);
  // Departed professors carry no ReCiterDB person type; etl:ed mirrors the
  // ED faculty SOR's expired professor-ranked records into former_professor.
  const formerProfessors = await db.write.formerProfessor.findMany({ select: { cwid: true } });
  for (const f of formerProfessors) excluded.add(f.cwid);
  const eligible = pairs.filter((p) => !excluded.has(p.menteeCwid));
  log(`${eligible.length} pairs after excluding faculty/professor-ranked mentees`);

  // 2. Rank + cap.
  const { rows: ranked, droppedByCap } = rankPairs(eligible);
  log(`${ranked.length} rows after per-mentor cap ${PER_MENTOR_CAP} (${droppedByCap} dropped)`);
  const keep = new Set(ranked.map((r) => pairKey(r.mentorCwid, r.menteeCwid)));
  const mentorCwids = Array.from(new Set(ranked.map((r) => r.mentorCwid)));
  const menteeCwids = Array.from(new Set(ranked.map((r) => r.menteeCwid)));

  // 3. Evidence: per-pub rows for the kept mentors, filtered to kept pairs.
  const tEvidence = Date.now();
  const evidenceByPair = new Map<string, Evidence[]>();
  for (const batch of chunks(mentorCwids, MENTOR_BATCH)) {
    await withReciterConnection(async (conn) => {
      const rows = (await conn.query(
        `SELECT me.personIdentifier AS menteeCwid, mt.personIdentifier AS mentorCwid,
                me.pmid, a.articleYear, a.article_id,
                me.\`rank\` AS menteeRank, mt.\`rank\` AS mentorRank,
                (SELECT MAX(x.\`rank\`) FROM analysis_summary_author_list x WHERE x.pmid = me.pmid) AS total
           FROM analysis_summary_author_list mt
           JOIN analysis_summary_article a ON a.pmid = mt.pmid AND a.articleYear >= ?
           JOIN analysis_summary_author_list me
             ON me.pmid = mt.pmid AND me.personIdentifier <> '' AND me.personIdentifier <> mt.personIdentifier
          WHERE mt.personIdentifier IN (?)`,
        [minYear, batch],
      )) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const key = pairKey(String(r.mentorCwid), String(r.menteeCwid));
        if (!keep.has(key)) continue;
        const list = evidenceByPair.get(key) ?? [];
        list.push({
          id: pubKey(Number(r.pmid), r.article_id == null ? null : String(r.article_id)),
          year: r.articleYear == null ? null : Number(r.articleYear),
          menteeRank: Number(r.menteeRank),
          mentorRank: Number(r.mentorRank),
          total: Number(r.total),
        });
        evidenceByPair.set(key, list);
      }
    });
  }
  for (const list of evidenceByPair.values()) {
    list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.id.localeCompare(b.id));
    list.splice(EVIDENCE_CAP);
  }
  log(`evidence for ${evidenceByPair.size} pairs in ${Date.now() - tEvidence}ms`);

  // 4. Mentee identity: person row, person types, first-published year (unwindowed).
  const person = new Map<string, PersonRow>();
  const types = new Map<string, string[]>();
  const firstPublished = new Map<string, number>();
  for (const batch of chunks(menteeCwids, IN_BATCH)) {
    await withReciterConnection(async (conn) => {
      const people = (await conn.query(
        `SELECT personIdentifier, firstName, lastName, title, primaryOrganizationalUnit
           FROM person WHERE personIdentifier IN (?)`,
        [batch],
      )) as PersonRow[];
      for (const p of people) person.set(p.personIdentifier, p);
      const typeRows = (await conn.query(
        `SELECT personIdentifier, personType FROM person_person_type WHERE personIdentifier IN (?)`,
        [batch],
      )) as Array<{ personIdentifier: string; personType: string }>;
      for (const t of typeRows) {
        const list = types.get(t.personIdentifier) ?? [];
        list.push(t.personType);
        types.set(t.personIdentifier, list);
      }
      const years = (await conn.query(
        `SELECT l.personIdentifier, MIN(a.articleYear) AS y
           FROM analysis_summary_author_list l
           JOIN analysis_summary_article a ON a.pmid = l.pmid
          WHERE l.personIdentifier IN (?)
          GROUP BY l.personIdentifier`,
        [batch],
      )) as Array<{ personIdentifier: string; y: number | null }>;
      for (const y of years) if (y.y != null) firstPublished.set(y.personIdentifier, Number(y.y));
    });
  }

  // 5. Assemble rows.
  let skippedNoPerson = 0;
  const rows: SuggestionRow[] = [];
  for (const r of ranked) {
    const p = person.get(r.menteeCwid);
    if (!p) {
      skippedNoPerson++; // ponytail: no `person` row => no display name; drop rather than invent one
      continue;
    }
    const kind = classifyMenteeKind(types.get(r.menteeCwid) ?? []);
    rows.push({
      mentorCwid: r.mentorCwid,
      menteeCwid: r.menteeCwid,
      menteeName: [p.firstName, p.lastName].filter(Boolean).join(" ") || r.menteeCwid,
      // ReCiterDB stores '' for a missing title/unit; null so `??` fallbacks work.
      menteeTitle: p.title?.trim() || null,
      menteeUnit: p.primaryOrganizationalUnit?.trim() || null,
      kind,
      tier: tierOf(kind),
      nCoPubs: r.nCoPubs,
      nMentorLastAuthor: r.nMentorLastAuthor,
      nMenteeFirstAuthor: r.nMenteeFirstAuthor,
      firstYear: r.firstYear,
      lastYear: r.lastYear,
      menteeFirstPublishedYear: firstPublished.get(r.menteeCwid) ?? null,
      strong: r.strong,
      evidence: evidenceByPair.get(pairKey(r.mentorCwid, r.menteeCwid)) ?? [],
      computedAt: now,
    });
  }
  if (skippedNoPerson > 0)
    log(`${skippedNoPerson} rows skipped: mentee has no reciterdb person row`);

  // 6. Write.
  const { upserted, pruned } = await writeSuggestions(rows);
  const strong = rows.filter((r) => r.strong).length;
  const summary: Summary = {
    pairs: pairs.length,
    rows: rows.length,
    strong,
    droppedByCap,
    upserted,
    pruned,
    ms: Date.now() - start,
  };
  log(
    `done in ${summary.ms}ms: upserted=${upserted} pruned=${pruned} strong=${strong} ` +
      `mentors=${mentorCwids.length} droppedByCap=${droppedByCap}`,
  );
  return summary;
}

// Standalone entrypoint (`npm run etl:reciter:mentee-suggestions`); importing
// this module from etl/reciter/index.ts or a test must not run it.
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  buildMenteeSuggestions()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await disconnect();
      await closeReciterPool();
    });
}
