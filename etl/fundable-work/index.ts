/**
 * Fundable work — WCM conference abstracts and preprints, scored for
 * private-funding potential. Read by `/edit/fundable-work`.
 *
 *   1. FETCH   OpenAlex works with a WCM affiliation, type conference-abstract or
 *              preprint, published in the last WINDOW_DAYS. Reciterdb cannot
 *              supply these: PubMed and Scopus skip meeting abstracts.
 *   2. MATCH   Authors from reciterdb's OpenAlex lane where it has the work: curator-
 *              resolved `authorship_review` rows (else the lane's proposed person) plus
 *              curator-added `external_article` OPENALEX:<W> rows (`reciterAuthors`). Works
 *              the lane never saw (older than ~365 days, or carrying a PMID) fall back to
 *              the honors matcher: each WCM authorship to exactly one active full-time
 *              faculty member or postdoc by full first name + surname. Only cwids in
 *              `scholar` are kept. A work needs at least one FACULTY author: the PI is the
 *              outreach target, and a postdoc-only item has no one to take it to a funder.
 *   3. SCORE   One Sonnet 5.5 call per new work: score, stage, rationale, pitch, funders.
 *              Grounded with the industry sponsors of the authors' own trials.
 *   4. WRITE   Each scored work as it lands, so a crash keeps what it paid for.
 *
 * Rows are scored once; a work already in `fundable_work` is not re-scored, but its
 * authors are re-derived every run (curators resolve the lane after first scoring). A
 * scored work that loses every faculty author keeps its row with whatever authors remain.
 *
 * Usage: `npm run etl:fundable-work`
 */
import { generateObject } from "ai";

import { db, disconnect } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { bedrockClient, BEDROCK_CACHE_POINT } from "@/lib/llm/client";
import { modelAcceptsTemperature } from "@/lib/llm/models";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import { getJson, mailtoFromEnv } from "@/lib/seo/openalex";
import { buildScholarIndex } from "../honors/lists/match";
import {
  matchFacultyAuthors,
  reciterAuthors,
  reconstructAbstract,
  scoringPrompt,
  ScoreSchema,
  SYSTEM_PROMPT,
  WCM_OPENALEX_IDS,
  WORK_TYPES,
  type OpenAlexWork,
  type ReviewRow,
} from "./work";

/** Two years: the first run backfills, later runs only score what is new. */
const WINDOW_DAYS = 730;
/** ponytail: per-run cost ceiling; a backfill bigger than this finishes next week. */
const MAX_SCORED_PER_RUN = 1500;
const CONCURRENCY = 4;
const TIMEOUT_MS = 120_000;
/** Sonnet 5.5: on a 40-item side-by-side it matched Opus 4.8's scores (25 exact, 38 within one)
 *  at a third of the cost, with no failed calls; Sonnet 4.5 inflated 4s and 5s. Granted in
 *  EtlTaskRoleBedrockPolicy. `fundable_work.model` records which model scored a row. */
const MODEL_ID = "us.anthropic.claude-sonnet-5-5";

async function fetchWorks(): Promise<OpenAlexWork[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const filter = [
    `institutions.id:${WCM_OPENALEX_IDS.join("|")}`,
    `type:${WORK_TYPES.join("|")}`,
    `from_publication_date:${since}`,
    "has_abstract:true",
  ].join(",");
  const select = "id,doi,title,type,publication_date,primary_location,abstract_inverted_index,authorships";
  const mailto = mailtoFromEnv();
  const works: OpenAlexWork[] = [];
  // ponytail: page= paging, because OpenAlex 401s keyless cursor= paging past page 1. It caps at
  // 10,000 results (the two-year window is ~2,200); past that, get an API key and use cursor=.
  for (let n = 1; ; n++) {
    const page: { results: OpenAlexWork[] } = await getJson(
      `https://api.openalex.org/works?filter=${filter}&select=${select}&per-page=200&page=${n}`,
      mailto,
    );
    works.push(...page.results);
    if (page.results.length < 200) return works;
  }
}

const IN_BATCH = 500;

/**
 * reciterdb's OpenAlex-lane rows for these bare W ids: review rows and non-suppressed
 * external_article uids, keyed by W id. Null when reciterdb can't be read; the caller then
 * falls back to the name matcher rather than fail the run.
 */
async function readReciter(
  ids: string[],
): Promise<{ reviews: Map<string, ReviewRow[]>; external: Map<string, string[]> } | null> {
  const reviews = new Map<string, ReviewRow[]>();
  const external = new Map<string, string[]>();
  try {
    for (let i = 0; i < ids.length; i += IN_BATCH) {
      const batch = ids.slice(i, i + IN_BATCH);
      await withReciterConnection(async (conn) => {
        const rows = (await conn.query(
          `SELECT external_id, status, top_cwid, resolution_cwid, author_position, author_position_label
           FROM authorship_review
           WHERE source = 'openalex' AND external_id IN (?)`,
          [batch],
        )) as Array<ReviewRow & { external_id: string }>;
        for (const r of rows) reviews.set(r.external_id, [...(reviews.get(r.external_id) ?? []), r]);
        const ext = (await conn.query(
          `SELECT article_id, uid FROM external_article
           WHERE article_id IN (?) AND suppressed = 0`,
          [batch.map((id) => `OPENALEX:${id}`)],
        )) as Array<{ article_id: string; uid: string }>;
        for (const e of ext) {
          const id = e.article_id.slice("OPENALEX:".length);
          external.set(id, [...(external.get(id) ?? []), e.uid]);
        }
      });
    }
  } catch (err) {
    console.warn(
      `[fundable-work] reciterdb read failed, using the name matcher for every work: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
  return { reviews, external };
}

async function main(): Promise<number> {
  const works = await fetchWorks();
  console.log(`OpenAlex: ${works.length} WCM conference abstracts + preprints.`);

  const people = await db.read.scholar.findMany({
    where: { roleCategory: { in: ["full_time_faculty", "postdoc"] }, status: "active", deletedAt: null },
    select: { cwid: true, preferredName: true, fullName: true, roleCategory: true },
  });
  const index = buildScholarIndex(people);
  const facultyCwids = new Set(people.filter((p) => p.roleCategory === "full_time_faculty").map((p) => p.cwid));

  const ids = works.map((w) => w.id.split("/").pop()!);
  const reciter = await readReciter(ids);
  const attributed = works.map((w, i) => {
    const matched = matchFacultyAuthors(w, index);
    const fromReciter = reciter
      ? reciterAuthors(reciter.reviews.get(ids[i]) ?? [], reciter.external.get(ids[i]) ?? [], matched)
      : null;
    return { work: w, id: ids[i], authors: fromReciter ?? matched };
  });
  // fundable_work_author.cwid is an FK to scholar: a reciterdb cwid SPS doesn't hold is dropped.
  const known = new Set(
    (
      await db.read.scholar.findMany({
        where: { cwid: { in: [...new Set(attributed.flatMap((t) => t.authors.map((a) => a.cwid)))] } },
        select: { cwid: true },
      })
    ).map((s) => s.cwid),
  );
  for (const t of attributed) t.authors = t.authors.filter((a) => known.has(a.cwid));
  const fromLane = reciter
    ? attributed.filter((t) => reciter.reviews.has(t.id) || reciter.external.has(t.id)).length
    : 0;
  console.log(`reciterdb: ${fromLane} of ${works.length} works attributed from the OpenAlex lane.`);

  const existing = new Map<string, string>();
  const scoredWorks = await db.read.fundableWork.findMany({
    select: { id: true, authors: { select: { cwid: true, position: true } } },
  });
  for (const w of scoredWorks) existing.set(w.id, authorKey(w.authors));

  // Refresh existing works' authors; no LLM call, no re-score. Skipped when reciterdb is down:
  // rewriting curator-resolved authors from the name matcher would undo them until next run.
  let refreshed = 0;
  if (reciter) {
    for (const t of attributed) {
      const before = existing.get(t.id);
      if (before === undefined || before === authorKey(t.authors)) continue;
      await db.write.$transaction([
        db.write.fundableWorkAuthor.deleteMany({ where: { workId: t.id } }),
        db.write.fundableWorkAuthor.createMany({ data: t.authors.map((a) => ({ workId: t.id, ...a })) }),
      ]);
      refreshed++;
    }
  }
  console.log(`Refreshed authors on ${refreshed} already-scored works.`);

  const todo = attributed
    .filter((t) => t.authors.some((a) => facultyCwids.has(a.cwid)) && !existing.has(t.id) && t.work.title)
    .slice(0, MAX_SCORED_PER_RUN);
  console.log(`${todo.length} new works with a full-time faculty author to score.`);

  const trialLinks = await db.read.personClinicalTrial.findMany({
    where: {
      cwid: { in: [...new Set(todo.flatMap((t) => t.authors.map((a) => a.cwid)))] },
      trial: { sponsorClass: "industry" },
    },
    select: { cwid: true, trial: { select: { principalSponsor: true } } },
  });
  const sponsorsByCwid = new Map<string, Set<string>>();
  for (const l of trialLinks) {
    if (!l.trial.principalSponsor) continue;
    const set = sponsorsByCwid.get(l.cwid) ?? new Set<string>();
    set.add(l.trial.principalSponsor);
    sponsorsByCwid.set(l.cwid, set);
  }

  let scored = 0;
  let failed = 0;
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const { work, id, authors } = t;
        const item = {
          type: work.type,
          title: work.title!,
          venue: work.primary_location?.source?.display_name ?? null,
          date: work.publication_date,
          abstract: reconstructAbstract(work.abstract_inverted_index),
        };
        const sponsors = [...new Set(authors.flatMap((a) => [...(sponsorsByCwid.get(a.cwid) ?? [])]))];
        try {
          const { object: s } = await generateObject({
            model: bedrockClient()(MODEL_ID),
            schema: ScoreSchema,
            messages: [
              { role: "system", content: SYSTEM_PROMPT, providerOptions: BEDROCK_CACHE_POINT },
              { role: "user", content: scoringPrompt(item, sponsors.slice(0, 15)) },
            ],
            allowSystemInMessages: true,
            maxOutputTokens: 4000,
            abortSignal: AbortSignal.timeout(TIMEOUT_MS),
            ...(modelAcceptsTemperature(MODEL_ID) ? { temperature: 0 } : {}),
          });
          await db.write.$transaction([
            db.write.fundableWork.create({
              data: {
                id,
                type: item.type,
                doi: work.doi?.replace(/^https:\/\/doi\.org\//, "").slice(0, 255) ?? null,
                title: item.title.slice(0, 1000),
                abstract: item.abstract,
                venue: item.venue?.slice(0, 255) ?? null,
                publicationDate: new Date(item.date),
                score: s.score,
                stage: s.stage,
                modality: s.modality?.slice(0, 255) ?? null,
                rationale: s.rationale,
                pitch: s.pitch,
                funders: s.funders,
                model: MODEL_ID,
              },
            }),
            db.write.fundableWorkAuthor.createMany({
              data: authors.map((a) => ({ workId: id, ...a })),
            }),
          ]);
          scored++;
        } catch (err) {
          failed++;
          console.warn(`[fundable-work] ${id} failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }),
  );

  console.log(`Scored ${scored}, failed ${failed}.`);
  // Some failures retry next week; ALL failing is an outage (IAM, Bedrock) worth an alarm.
  if (failed > 0 && scored === 0) throw new Error(`all ${failed} scoring calls failed`);
  return scored;
}

/** Order-free fingerprint of a work's author rows, to skip rewriting unchanged ones. */
function authorKey(authors: Array<{ cwid: string; position: string }>): string {
  return authors.map((a) => `${a.cwid}:${a.position}`).sort().join(",");
}

withEtlRun("FundableWork", main)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => Promise.all([disconnect(), closeReciterPool()]));
