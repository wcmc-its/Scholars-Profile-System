/**
 * Fundable work — WCM conference abstracts and preprints, scored for
 * private-funding potential. Read by `/edit/fundable-work`.
 *
 *   1. FETCH   OpenAlex works with a WCM affiliation, type conference-abstract or
 *              preprint, published in the last WINDOW_DAYS. Reciterdb cannot
 *              supply these: PubMed and Scopus skip meeting abstracts.
 *   2. MATCH   Each WCM authorship to exactly one active full-time faculty member or
 *              postdoc (the honors matcher: full first name + surname). A work needs
 *              at least one FACULTY author: the PI is the outreach target, and a
 *              postdoc-only item has no one to take it to a funder.
 *   3. SCORE   One Sonnet 5.5 call per new work: score, stage, rationale, pitch, funders.
 *              Grounded with the industry sponsors of the authors' own trials.
 *   4. WRITE   Each scored work as it lands, so a crash keeps what it paid for.
 *
 * Rows are scored once; a work already in `fundable_work` is skipped.
 *
 * Usage: `npm run etl:fundable-work`
 */
import { generateObject } from "ai";

import { db, disconnect } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { bedrockClient, BEDROCK_CACHE_POINT } from "@/lib/llm/client";
import { modelAcceptsTemperature } from "@/lib/llm/models";
import { getJson, mailtoFromEnv } from "@/lib/seo/openalex";
import { buildScholarIndex } from "../honors/lists/match";
import {
  matchFacultyAuthors,
  reconstructAbstract,
  scoringPrompt,
  ScoreSchema,
  SYSTEM_PROMPT,
  WCM_OPENALEX_IDS,
  WORK_TYPES,
  type OpenAlexWork,
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

async function main(): Promise<number> {
  const works = await fetchWorks();
  console.log(`OpenAlex: ${works.length} WCM conference abstracts + preprints.`);

  const people = await db.read.scholar.findMany({
    where: { roleCategory: { in: ["full_time_faculty", "postdoc"] }, status: "active", deletedAt: null },
    select: { cwid: true, preferredName: true, fullName: true, roleCategory: true },
  });
  const index = buildScholarIndex(people);
  const facultyCwids = new Set(people.filter((p) => p.roleCategory === "full_time_faculty").map((p) => p.cwid));

  const existing = new Set(
    (await db.read.fundableWork.findMany({ select: { id: true } })).map((w) => w.id),
  );
  const todo = works
    .map((w) => ({ work: w, id: w.id.split("/").pop()!, authors: matchFacultyAuthors(w, index) }))
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

withEtlRun("FundableWork", main)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(disconnect);
