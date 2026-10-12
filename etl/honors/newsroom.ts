/**
 * Newsroom honors (#3040): faculty honors announced on the WCM Newsroom, proposed
 * as PENDING rows for `/edit/honors-queue`. It never publishes anything.
 *
 * The Newsroom covers the awards our roster scraper cannot reach (most award
 * bodies 403 a non-browser client or render their roster client-side). It is
 * one more list in `scholars-honors-<env>` (id `newsroom`, lib/honors/lists.ts),
 * so it gets Run now, an `honor_list_run` row and a Sources tab line.
 *
 *   1. WALK  news.weill.cornell.edu/news/feed.json, newest first. The weekly run
 *            stops at RECENT_DAYS. Older posts are re-read harmlessly (see the
 *            rules in planNewsroom). Until the list has one successful run, it
 *            walks the whole archive (back to 1997) instead.
 *            ponytail: the backfill must fit the 45 min task timeout. ~1k
 *            screened posts at 4 concurrent calls and the 2-5 s per call seen
 *            live is ~15 min. If Bedrock throttling pushes it past that, the
 *            run fails and the next weekly run retries; raise the timeout then.
 *   2. SCREEN  Keep a post typed `Awards & Honors`, or one whose title
 *            reads like an honor and not like a grant. The category alone misses
 *            some top-tier honors filed as `News from WCM`.
 *   3. EXTRACT  Sonnet (Bedrock, already granted on the ETL task role) lists each
 *            faculty honor in the post: person, honor, body, year, a quote. It
 *            drops grants (InfoEd's job), student and institutional awards. The
 *            roundups are why this is an LLM: one post names dozens of people.
 *   4. NORMALIZE  Map organization and honor name onto the strings already in the
 *            honor table, so the seed import, the roster scraper and this source
 *            share one (cwid, organization, name) key and do not duplicate.
 *   5. ATTRIBUTE  The article's own VIVO `cwid-` link first, then the roster
 *            scraper's conservative name matcher (full first name + surname,
 *            nickname fallback, breadth gate).
 *   6. PLAN  The roster scraper's rules: a (cwid, organization, name) with a row
 *            in ANY status is left alone. Everything else is a new pending row.
 */
import { generateObject } from "ai";
import { z } from "zod";

import type { HonorListCategory, HonorListMeta } from "@/lib/honors/lists";
import { bedrockClient, BEDROCK_CACHE_POINT } from "@/lib/llm/client";
import { DEFAULT_EXTRACT_MODEL, modelAcceptsTemperature } from "@/lib/llm/models";

import { CWID_RE, NEWS_ORIGIN, NEWS_PATH_PREFIX } from "../news/seed";
import { parseDate, stripControl, stripTags } from "../news/scrape";
import type { Fetcher } from "./lists/html";
import {
  EVIDENCE_MAX,
  foldToken,
  matchEntry,
  type ScholarIndex,
  splitDisplayName,
} from "./lists/match";
import {
  HONORS_SCRAPER_ACTOR,
  type ExistingHonor,
  type HonorCreate,
  type ListPlan,
} from "./lists/plan";

export const NEWSROOM_FEED = `${NEWS_ORIGIN}/news/feed.json`;

/** The weekly window. Wider than a week so a missed run or a late-dated post
 *  is still read; re-reading is idempotent. */
export const RECENT_DAYS = 60;
/** Hard ceiling on feed pages (~50 live, 100 stories each). */
const MAX_FEED_PAGES = 80;
/** Concurrent model calls. A backfill is ~1k screened posts. */
const EXTRACT_CONCURRENCY = 4;
const EXTRACT_TIMEOUT_MS = 120_000;
/** Post text sent to the model. The longest roundups run ~25k chars. */
const POST_TEXT_MAX = 40_000;
/** `honor.source_ref` is VARCHAR(512). */
const SOURCE_REF_MAX = 512;
/** Canonical (organization, name) pairs handed to the model. */
const VOCAB_MAX = 400;

/** Must stay a Sonnet: the ETL task role is granted only those
 *  (EtlTaskRoleBedrockPolicy). */
const MODEL_ID = DEFAULT_EXTRACT_MODEL;

export type NewsroomPost = {
  url: string;
  title: string;
  /** `field_story_type`: "Awards & Honors", "News from WCM", … */
  storyType: string;
  publishedAt: string | null;
  /** VIVO-linked cwids in the body. */
  cwids: string[];
  /** Body prose, each VIVO-linked name followed by `[cwid-<cwid>]`. */
  text: string;
};

const clean = (s: string) => stripControl(stripTags(s));

/** Body HTML to prose, keeping each VIVO link as a `[cwid-x]` marker after the
 *  linked name, so the model can say which person a link names. */
export function annotatedText(bodyHtml: string): string {
  const marked = bodyHtml.replace(
    /<a\b[^>]*href="[^"]*cwid-([A-Za-z0-9]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, cwid: string, inner: string) => `${inner} [cwid-${cwid.toLowerCase()}]`,
  );
  return clean(marked);
}

/** One feed page to posts. Malformed stories are skipped, not fatal. */
export function parseFeedPage(json: string): NewsroomPost[] {
  const list = (JSON.parse(json) as { news_stories?: unknown }).news_stories;
  if (!Array.isArray(list)) throw new Error("feed.json: missing news_stories array");
  const out: NewsroomPost[] = [];
  for (const entry of list) {
    const s = (entry as { story?: Record<string, unknown> })?.story;
    if (!s || typeof s !== "object") continue;
    const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : "");
    const url = str("path");
    const title = clean(str("title"));
    if (!url.startsWith(NEWS_ORIGIN + NEWS_PATH_PREFIX) || !title) continue;
    const body = str("field_story_body");
    const cwids = new Set<string>();
    for (const m of body.matchAll(/cwid-([A-Za-z0-9]+)/g)) {
      const c = m[1].toLowerCase();
      if (CWID_RE.test(c)) cwids.add(c);
    }
    out.push({
      url,
      title,
      storyType: clean(str("field_story_type")),
      publishedAt: parseDate(str("field_story_post_date")),
      cwids: [...cwids],
      text: annotatedText(body).slice(0, POST_TEXT_MAX),
    });
  }
  return out;
}

const AWARDS_TYPE = /^awards\s*(?:&|and)\s*honou?rs$/i;
const HONOR_WORDS =
  /\b(?:elected|inducted|named|wins?|won|receives?|received|awarded|honou?red|recogni[sz]ed|prize|medal|awards?|fellows?(?:hip)?|investigator|lectureship|laureate|distinguished|lifetime achievement)\b/i;
const GRANT_WORDS = /\b(?:grants?|R01|R21|U01|P01|P30|K08|K23|contract|funding|funded|\$\s?\d)/i;

/** Step 2: does this post plausibly announce a faculty honor? Title only: a
 *  research story's teaser ("investigators found…", "the award-winning lab")
 *  trips the honor words, while an honor post names the honor in its title. */
export function screenPost(p: Pick<NewsroomPost, "storyType" | "title">): boolean {
  if (AWARDS_TYPE.test(p.storyType)) return true;
  return HONOR_WORDS.test(p.title) && !GRANT_WORDS.test(p.title);
}

export type FeedWalk = { posts: NewsroomPost[]; complete: boolean; warning: string | null };

/** Step 1: walk the feed newest-first down to `floor` (YYYY-MM-DD, or null for
 *  the whole archive). A later page that fails ends the walk as partial. */
export async function walkFeed(fetcher: Fetcher, floor: string | null): Promise<FeedWalk> {
  const posts: NewsroomPost[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    let json: string;
    try {
      json = await fetcher(`${NEWSROOM_FEED}?page=${page}`);
    } catch (err) {
      if (page === 0) throw err;
      const why = err instanceof Error ? err.message : String(err);
      return {
        posts,
        complete: false,
        warning: `Feed page ${page} could not be read (${why}); older posts were not checked.`,
      };
    }
    const batch = parseFeedPage(json).filter((p) => !seen.has(p.url) && (seen.add(p.url), true));
    if (batch.length === 0) {
      if (page === 0)
        throw new Error("The newsroom feed returned no stories; the feed may have changed.");
      break;
    }
    const inWindow = floor
      ? batch.filter((p) => p.publishedAt === null || p.publishedAt >= floor)
      : batch;
    posts.push(...inWindow);
    if (floor && inWindow.length < batch.length) break; // newest-first: the rest are older
  }
  return { posts, complete: true, warning: null };
}

const CATEGORIES = ["ACADEMY_MEMBERSHIP", "INVESTIGATORSHIP", "PRIZE", "OTHER"] as const;

export const ExtractSchema = z.object({
  honors: z.array(
    z.object({
      scholarName: z.string(),
      cwid: z.string().nullish(),
      honorName: z.string(),
      organization: z.string(),
      year: z.number().int().nullish(),
      category: z.enum(CATEGORIES),
      quote: z.string(),
    }),
  ),
});
export type ExtractedHonor = z.infer<typeof ExtractSchema>["honors"][number];

/** The honor strings already in use, which the model maps onto. */
export type Vocabulary = ReadonlyArray<{ organization: string; name: string }>;

export function systemPrompt(vocab: Vocabulary): string {
  const pairs = vocab
    .slice(0, VOCAB_MAX)
    .map((v) => `- ${v.organization} | ${v.name}`)
    .join("\n");
  return `You read Weill Cornell Medicine newsroom posts and list the individual honors they announce for Weill Cornell faculty.

Include: elections to academies and learned societies, named fellowships of a society, named investigatorships, prizes, medals, named lectureships and other awards conferred on ONE named faculty member in recognition of their work. A competitively awarded career distinction that carries money (NIH Director's Pioneer Award, Sloan Research Fellowship) counts. Weill Cornell's own awards to faculty count too: teaching, mentoring, clinical and research awards (for example the Excellence in Medical Education Awards); use "Weill Cornell Medicine" as the organization.

Exclude: research grants, contracts and project funding (another system records those); student, trainee, resident and fellow-in-training awards; awards to a team, department, program or institution; Weill Cornell appointments, promotions and endowed chairs (an award is not an appointment); honors for people who are not Weill Cornell faculty; honors the post only mentions in passing as past background.

For each honor return:
- scholarName: the person's name as printed, without "Dr." or degrees.
- cwid: if the name is followed by a marker like [cwid-abc1234], that id (abc1234); otherwise null.
- organization: the conferring body, written out in full. If it matches one of the KNOWN HONORS below, copy that organization string exactly.
- honorName: the honor itself. For an academy or society election use the membership title ("Member", "Fellow"); for a prize use the prize name. If it matches a KNOWN HONOR for that organization, copy the name exactly.
- year: the year the honor was conferred, if the post states or clearly implies it; otherwise null.
- category: ACADEMY_MEMBERSHIP (elected membership or fellowship of an academy or learned society), INVESTIGATORSHIP (a named investigator appointment such as HHMI), PRIZE (an award, prize, medal or lectureship), or OTHER.
- quote: the shortest sentence from the post that names the person and the honor, verbatim, without the [cwid-…] marker.

Return an empty list when the post announces no qualifying honor.

KNOWN HONORS (organization | name):
${pairs}`;
}

export type Extractor = (post: NewsroomPost, system: string) => Promise<ExtractedHonor[]>;

/** Step 3 against Bedrock. */
export const bedrockExtract: Extractor = async (post, system) => {
  const { object } = await generateObject({
    model: bedrockClient()(MODEL_ID),
    schema: ExtractSchema,
    messages: [
      { role: "system", content: system, providerOptions: BEDROCK_CACHE_POINT },
      {
        role: "user",
        content: `Title: ${post.title}\nPosted: ${post.publishedAt ?? "unknown"}\nCategory: ${post.storyType || "unknown"}\n\n${post.text}`,
      },
    ],
    // A message, not `system`, so the long vocabulary prefix can carry the
    // prompt-cache checkpoint; the prompt is ours, not user input.
    allowSystemInMessages: true,
    maxOutputTokens: 8000,
    abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    ...(modelAcceptsTemperature(MODEL_ID) ? { temperature: 0 } : {}),
  });
  return object.honors;
};

/** Fold an honor string for comparison: case, accents, "&"/"and", a leading "the",
 *  punctuation and spacing. */
export function foldHonor(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/** Unambiguous former and short names. "AAAS" is deliberately absent: it is
 *  both the Association for the Advancement of Science and the Academy of Arts
 *  and Sciences. */
const ORG_ALIASES: Readonly<Record<string, string>> = {
  "institute of medicine": "National Academy of Medicine",
  "national academy of medicine": "National Academy of Medicine",
  nam: "National Academy of Medicine",
  nas: "National Academy of Sciences",
  hhmi: "Howard Hughes Medical Institute",
  asci: "American Society for Clinical Investigation",
  aap: "Association of American Physicians",
  "macarthur foundation": "John D. and Catherine T. MacArthur Foundation",
  "sloan foundation": "Alfred P. Sloan Foundation",
  "pew charitable trusts": "Pew Charitable Trusts",
};

/** Step 4: canonical organization and honor name. An organization already in
 *  use (or a known alias of one) takes that spelling; a name already used under
 *  that organization takes that spelling. Anything else is kept as extracted. */
export function normalizeHonor(
  h: Pick<ExtractedHonor, "organization" | "honorName">,
  vocab: Vocabulary,
): { organization: string; name: string } {
  const orgs = new Map<string, string>();
  for (const v of vocab)
    if (!orgs.has(foldHonor(v.organization))) orgs.set(foldHonor(v.organization), v.organization);
  const foldedOrg = foldHonor(h.organization);
  const alias = ORG_ALIASES[foldedOrg];
  const organization =
    orgs.get(foldedOrg) ?? (alias ? (orgs.get(foldHonor(alias)) ?? alias) : h.organization.trim());
  const foldedName = foldHonor(h.honorName);
  const name =
    vocab.find((v) => v.organization === organization && foldHonor(v.name) === foldedName)?.name ??
    h.honorName.trim();
  return { organization, name };
}

const clip = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;

/** A stable per-honor fragment, so two honors for one person in one post are
 *  two queue lines rather than contested siblings. */
function honorSlug(organization: string, name: string): string {
  return foldHonor(`${organization} ${name}`).replace(/ /g, "-").slice(0, 120);
}

export type PostExtraction = { post: NewsroomPost; honors: ExtractedHonor[] };

export type NewsroomExisting = ExistingHonor & {
  organization: string;
  name: string;
  sourceRef: string | null;
};

/** The article a newsroom row's `sourceRef` names (`<url>#<slug>|…`). */
const articleOf = (sourceRef: string) => sourceRef.split("|")[0].split("#")[0];

const rowKey = (cwid: string, organization: string, name: string) =>
  `${cwid}\u0000${foldHonor(organization)}\u0000${foldHonor(name)}`;

/**
 * Steps 4 to 6, pure. Mirrors `planList`: an existing (cwid, organization, name)
 * in any status is left alone except to fill a missing evidence line on a
 * pending row; a line one of whose candidates already holds the honor proposes
 * nobody else; each (cwid, honor) is proposed at most once per run.
 *
 * One more rule, because the strings come from a model: a scholar who already
 * has a row from an article is never proposed again from that article. The
 * weekly window re-reads each post several times, and a second reading that
 * words the honor differently ("Elected Member") would otherwise slip past the
 * (cwid, organization, name) key and re-propose an honor a curator rejected.
 */
export function planNewsroom(
  meta: Pick<HonorListMeta, "source">,
  extractions: readonly PostExtraction[],
  index: ScholarIndex,
  existing: readonly NewsroomExisting[],
  vocab: Vocabulary,
): ListPlan {
  const byKey = new Map<string, NewsroomExisting>();
  for (const e of existing) {
    const k = rowKey(e.cwid, e.organization, e.name);
    if (!byKey.has(k)) byKey.set(k, e);
  }
  const fromArticle = new Set(
    existing.filter((e) => e.sourceRef).map((e) => `${e.cwid}\u0000${articleOf(e.sourceRef!)}`),
  );
  // Surnames per scholar, to check a cwid the model attached to a name.
  const familiesOf = new Map<string, Set<string>>();
  for (const [key, cwids] of index.byKey) {
    const family = key.slice(key.indexOf("|") + 1);
    for (const c of cwids) familiesOf.set(c, (familiesOf.get(c) ?? new Set()).add(family));
  }
  const creates: HonorCreate[] = [];
  const evidenceFills: ListPlan["evidenceFills"] = [];
  const touched = new Set<string>();
  let total = 0;
  let matched = 0;

  for (const { post, honors } of extractions) {
    const postYear = post.publishedAt ? Number(post.publishedAt.slice(0, 4)) : null;
    const prose = foldToken(post.text.replace(/\s+/g, "")).replace(/-/g, "");
    for (const h of honors) {
      const split = splitDisplayName(h.scholarName);
      // A name the post never prints is a model invention.
      if (!split || !prose.includes(split.family.replace(/-/g, ""))) continue;
      total += 1;
      // The model pairs names with `[cwid-x]` markers; trust a pairing only when
      // the article links that cwid and it is a scholar with this surname.
      const raw = h.cwid?.toLowerCase().replace(/^cwid-/, "") ?? null;
      const hint =
        raw && post.cwids.includes(raw) && familiesOf.get(raw)?.has(split.family) ? raw : null;
      const candidates = matchEntry(
        {
          printedName: h.scholarName,
          given: split.given,
          family: split.family,
          affiliation: "Weill Cornell Medicine", // the newsroom's own faculty
          year: h.year ?? postYear,
          cwidHint: hint,
        },
        index,
      );
      if (candidates.length === 0) continue;
      matched += 1;
      const { organization, name } = normalizeHonor(h, vocab);
      const year = h.year ?? postYear;
      const sourceRef = clip(
        `${post.url}#${honorSlug(organization, name)}|${h.scholarName.replace(/\|/g, "/").trim()}|${year ?? ""}`,
        SOURCE_REF_MAX,
      );
      const lineClaimed = candidates.some((c) => byKey.has(rowKey(c.cwid, organization, name)));
      for (const c of candidates) {
        const k = rowKey(c.cwid, organization, name);
        if (touched.has(k)) continue;
        touched.add(k);
        const basis = c.evidence.startsWith("Nickname") ? "Nickname match. " : "";
        const evidence = clip(
          `${basis}“${h.quote.replace(/\s*\[cwid-[a-z0-9]+\]/gi, "").trim()}”`,
          EVIDENCE_MAX,
        );
        const prior = byKey.get(k);
        if (prior) {
          if (prior.status === "pending" && !prior.evidence)
            evidenceFills.push({ id: prior.id, evidence });
          continue;
        }
        if (lineClaimed || fromArticle.has(`${c.cwid}\u0000${post.url}`)) continue;
        creates.push({
          cwid: c.cwid,
          category: h.category as HonorListCategory,
          name: clip(name, 255),
          organization: clip(organization, 255),
          year,
          status: "pending",
          showOnProfile: true,
          source: meta.source,
          sourceRef,
          enteredByCwid: HONORS_SCRAPER_ACTOR,
          evidence,
        });
      }
    }
  }
  return { onListTotal: total, matched, creates, evidenceFills };
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export type NewsroomScrape = { plan: ListPlan; complete: boolean; warning: string | null };

/** Steps 1 to 6 for one run. */
export async function scrapeNewsroom(args: {
  meta: Pick<HonorListMeta, "source">;
  fetcher: Fetcher;
  index: ScholarIndex;
  existing: readonly NewsroomExisting[];
  vocab: Vocabulary;
  backfill: boolean;
  extract?: Extractor;
  now?: Date;
}): Promise<NewsroomScrape> {
  const now = args.now ?? new Date();
  const floor = args.backfill
    ? null
    : new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const walk = await walkFeed(args.fetcher, floor);
  const screened = walk.posts.filter(screenPost);
  console.log(
    `[Honors] newsroom: ${walk.posts.length} post(s) since ${floor ?? "the start of the archive"}, ${screened.length} screened in`,
  );
  const system = systemPrompt(args.vocab);
  const extract = args.extract ?? bedrockExtract;
  const failures: string[] = [];
  const results = await pool(screened, EXTRACT_CONCURRENCY, async (post) => {
    try {
      return { post, honors: await extract(post, system) };
    } catch (err) {
      failures.push(`${post.url}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  });
  if (screened.length > 0 && failures.length === screened.length) {
    throw new Error(
      `The model could not read any of ${screened.length} post(s). First error: ${failures[0]}`,
    );
  }
  if (failures.length)
    console.warn(
      `[Honors] newsroom: ${failures.length} post(s) failed:\n  ${failures.join("\n  ")}`,
    );
  const plan = planNewsroom(
    args.meta,
    results.filter((r): r is PostExtraction => r !== null),
    args.index,
    args.existing,
    args.vocab,
  );
  const warnings = [
    walk.warning,
    failures.length
      ? `${failures.length} of ${screened.length} post(s) could not be read by the model.`
      : null,
  ].filter(Boolean);
  return {
    plan,
    complete: walk.complete && failures.length === 0,
    warning: warnings.length ? warnings.join(" ") : null,
  };
}
