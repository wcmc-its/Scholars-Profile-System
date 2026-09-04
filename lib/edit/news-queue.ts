/**
 * The news-mentions approval queue loader (docs/2026-07-18-news-mentions-plan.md).
 *
 * etl/news attaches a scholar to an article two ways: a VIVO cwid link (trusted,
 * published straight away) or a prose full-name match (untrusted — one PENDING
 * row per candidate). This queue is where comms confirms the name matches before
 * they reach a public profile. A full name that matched more than one scholar
 * yields competing candidates sharing a `sourceRef` (`<url>|<foldedName>`): at
 * most one is the right person, so approving one MUST reject the siblings (the
 * decision route does this atomically — see app/api/edit/news-mention/decision).
 *
 * Read-only and pure of authz: the caller gates (isSuperuser || isCommsSteward).
 *
 * 🔴 This module reaches the CLIENT bundle: `components/edit/news-queue.tsx` is
 * a "use client" component with a runtime `NEWS_HISTORY_LIMIT` import (and now
 * `sortNewsQueueGroups`). Nothing in this file's import graph may construct
 * `prisma` at module scope or import `@/lib/db` — that drags the mariadb driver
 * into the browser and breaks the Next build on `fs`/`net` (the same trap
 * documented on `lib/edit/manageable-units.ts`). `@/lib/api/prominence` is safe
 * on that count: its Prisma import is type-only and it holds no module state.
 * `@/lib/postnominal` is safe too, and so is the ONE hop it adds to the graph
 * (#2599) — `@/lib/postnominal` → `@/lib/eligibility`: that module has ZERO
 * imports of any kind, declares only `const` arrays/Sets and pure functions plus
 * types, and never names `prisma` or `PrismaClient`. It is already in the client
 * bundle by other routes (`components/publication/author-chip-row.tsx` and
 * `components/scholar/mentoring-section.tsx` are both "use client" and import
 * `isPubliclyDisplayed` from it), which is why it is deliberately NOT typed against
 * generated Prisma — see its `publicRoleWhere` docblock.
 */
import { tokenizeWithSpans } from "@/etl/news/names";
import { LEADERSHIP_TIER, computeProminence } from "@/lib/api/prominence";
import { formatPublishedName } from "@/lib/postnominal";
import { formatRoleCategory } from "@/lib/role-display";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { NewsMentionStatus } from "@/lib/generated/prisma/enums";

/** The Prisma surface this loader needs — a hand-rolled structural type does NOT
 *  accept a real `PrismaClient`, so Pick from it. `grant` /
 *  `orgUnitRoleAssignment` are `computeProminence`'s reads, not this loader's. */
type NewsQueueClient = Pick<
  PrismaClient,
  "newsMention" | "scholar" | "grant" | "orgUnitRoleAssignment"
>;

export type NewsQueueRow = {
  id: string;
  cwid: string;
  slug: string | null;
  /** The name AS THE PROFILE RENDERS IT — `formatPublishedName`, the same builder
   *  `lib/api/profile.ts` uses for the profile `<h1>`, so this previews what an
   *  approval publishes. Not a bare `preferredName + postnominal`: it normalizes
   *  ("Doctor of Philosophy" → "PhD") and suppresses an enrolled doctoral student's
   *  programme-of-study degree entirely (#2599). */
  scholarName: string;
  roleLabel: string | null;
  roleCategory: string | null;
  /** The scholar's primary title + department — the disambiguators the reviewer
   *  weighs when a name matched more than one person. */
  title: string | null;
  department: string | null;
  articleTitle: string;
  articleUrl: string;
  publishedAt: string | null;
  /** The prose name string the ETL matched — "the name being matched against". */
  detectedName: string | null;
  likelihood: string | null;
  /** WHERE the name was found — TAG | BODY | CAPTION | TITLE (#2578). The "why"
   *  behind the likelihood, which also folds in contested-ness and so can't
   *  carry it. Null on VIVO/CURATOR rows and on NAME rows matched before #2578. */
  matchBasis: string | null;
  /** ~200-300 chars of raw article text around the matched name (#2578 follow-
   *  up), rendered beneath the candidate so a reviewer can judge it without
   *  opening the article. Null on VIVO/CURATOR rows, on a TAG/CAPTION NAME row
   *  (no prose position to snippet), and on a NAME row matched before this
   *  shipped. */
  contextSnippet: string | null;
  /** True when the SCHOLAR THEMSELVES turned this mention down — they clicked
   *  "Not me" on their own /edit news card, which is a disavowal of an article
   *  about them, not a comms triage decision. The Rejected tab can now approve a
   *  row back onto a public profile, so this must be visible: re-approving one
   *  of these republishes something its subject explicitly declined. */
  declinedByScholar: boolean;
  /** Character ranges of the detected name INSIDE `contextSnippet`, so the queue
   *  can emphasise the name the reviewer is judging instead of making them find
   *  it in ~300 chars of scraped prose. Empty when there is nothing to mark.
   *  Computed here rather than stored: see `snippetMatchRanges`. */
  contextSnippetMatches: [number, number][];
  /** How the ETL attached this scholar: `VIVO` (trusted cwid link, auto-published)
   *  or `NAME` (prose match, queue-reviewed). Only shown on the history tabs —
   *  pending is name-only. */
  source: string;
  sourceRef: string | null;
  createdAt: string;
  /** When decided (approve/reject) — its `updatedAt`; equals seed time on Pending. */
  decidedAt: string;
  /** Competing candidates for the same detected name (contested groups only). */
  competingCwids: string[];
  /** The EDITORIAL half of the decision: "do we want this on the profile?".
   *  Orthogonal to `status`, which is the CORRECTNESS half ("is this the right
   *  person?"). "Approved but don't publish" is `status='published'` +
   *  `showOnProfile=false` — deliberately not a fourth status. */
  showOnProfile: boolean;
  /** The mentioned scholar's prominence score (`lib/api/prominence.ts`); higher
   *  is more prominent, 0 when the cwid has no scholar row. Drives the queue's
   *  optional "prominence" sort — comms triages the Dean before a postdoc. */
  prominence: number;
  /** Leadership sort tier (0 Dean · 1 deanery · 2 chair/chief · 3 none); 3 when
   *  the cwid has no scholar row. */
  leadershipTier: number;
  /** Display name of the last human to decide this row (`entered_by_cwid`), or
   *  null for an ETL-written row. The actor is often a comms steward who is NOT
   *  one of the queue's own scholars — see the loader's scholar read. */
  decidedByName: string | null;
};

/** One detected-name's worth of candidates. A group of 1 is the normal case. */
export type NewsQueueGroup = {
  /** `sourceRef` when present; otherwise the row id (an unlinked singleton). */
  key: string;
  rows: NewsQueueRow[];
  /** The prose name shared by every candidate on a contested group. */
  detectedName: string | null;
  /** True when >1 scholar competes for one detected name ⇒ approving one MUST
   *  reject the others. The UI must not offer a plain "approve" here. */
  contested: boolean;
};

/**
 * Character ranges of `detectedName` inside `contextSnippet`, for the queue's
 * name highlight.
 *
 * Derived at read time, NOT stored. Marking the name in the stored string (an
 * ETL-side `((...))` wrapper, the way `authorsString` marks WCM authors) would
 * mean re-running the news backfill over every existing row to see it — and the
 * news ETL is incremental, so `scrapeNews()` never revisits an article already
 * in `news_mention`. Recomputing costs one tokenise of a <=512-char string and
 * lights up every row already in the table.
 *
 * Matching mirrors the ETL's own: `tokenizeWithSpans` folds tokens (case,
 * diacritics, punctuation) while keeping the ORIGINAL character offsets, so the
 * prose's own spelling is what gets marked. A plain `indexOf(detectedName)`
 * would miss most rows — `detectedName` is the roster's `preferredName ??
 * fullName`, not the article's wording, so it does not match "Dr. Chen" or an
 * accented spelling.
 *
 * Every stored snippet contains the name by construction: `proseSnippet()` only
 * returns one for a sequence actually located in the prose, and BODY/TITLE build
 * theirs from the scored occurrence's own offsets — a mention with no prose
 * position gets a null snippet, not a name-less one. The surname fallback is
 * therefore for the roster drifting away from what the ETL matched on (the
 * snippet may have been anchored on `fullName` while `detectedName` holds a
 * since-changed `preferredName`), not for the ordinary case.
 */
export function snippetMatchRanges(
  snippet: string | null,
  detectedName: string | null,
): [number, number][] {
  if (!snippet || !detectedName) return [];
  const spans = tokenizeWithSpans(snippet);
  const wanted = tokenizeWithSpans(detectedName).map((t) => t.token);
  if (spans.length === 0 || wanted.length === 0) return [];

  const findSequence = (seq: string[]): [number, number][] => {
    const found: [number, number][] = [];
    for (let i = 0; i + seq.length <= spans.length; i++) {
      if (seq.some((tok, j) => spans[i + j]!.token !== tok)) continue;
      found.push([spans[i]!.start, spans[i + seq.length - 1]!.end]);
      i += seq.length - 1; // never overlap two marks
    }
    return found;
  };

  const whole = findSequence(wanted);
  // ponytail: surname alone is the fallback, so two unrelated Smiths in one
  // snippet both light up. Harmless on a review aid — it can only over-mark,
  // never hide the name — and it only fires when the full name did not match.
  return whole.length > 0 ? whole : findSequence([wanted[wanted.length - 1]!]);
}

/** True totals for the queue headers. The history tabs are CAPPED, so their
 *  loaded rows cannot be counted for a header without lying once the corpus
 *  passes the cap. */
export type NewsQueueCounts = {
  approved: number;
  /** Approved but deliberately NOT on the profile (`showOnProfile = false`) —
   *  the "approved but don't publish" state. This is the number a steward
   *  auditing suppressed mentions acts on, so it must be the real one. */
  approvedHidden: number;
};

/**
 * Count published / published-but-hidden mentions at the DB.
 *
 * Separate from `loadNewsQueue` on purpose: that function is capped at
 * NEWS_HISTORY_LIMIT for the history tabs, so its rows are a WINDOW, not a
 * population. Two indexed counts are cheaper than lifting the cap, and keeping
 * them apart stops anyone "simplifying" the header back onto the capped rows.
 */
export async function loadNewsQueueCounts(
  client: Pick<NewsQueueClient, "newsMention">,
): Promise<NewsQueueCounts> {
  const [approved, approvedHidden] = await Promise.all([
    client.newsMention.count({ where: { status: "published" } }),
    client.newsMention.count({ where: { status: "published", showOnProfile: false } }),
  ]);
  return { approved, approvedHidden };
}

export function isNewsQueueEnabled(): boolean {
  return process.env.NEWS_APPROVAL_QUEUE === "on";
}

/**
 * Whether to advertise the "News" tab in the admin sub-nav for this viewer: the
 * surface is enabled AND the viewer can open it. Mirrors `isHonorsQueueTabVisible`.
 *
 * 🔴 `isSuperuser || isCommsSteward`, never a bare `isCommsSteward`: the session
 * route reports role booleans as `false` FOR a superuser to skip a redundant
 * LDAPS call, and a bare role read would lock superusers out of a surface they
 * administer.
 */
export function isNewsQueueTabVisible(session: {
  isSuperuser: boolean;
  isCommsSteward?: boolean;
}): boolean {
  return isNewsQueueEnabled() && (session.isSuperuser || session.isCommsSteward === true);
}

/**
 * Pending sort weight. LOW ranks ABOVE the 0 fallback on purpose: 0 is what an
 * unknown/absent likelihood scores (a pre-#2578 row, or a contested group, which
 * is forced to 0 below), and a scored LOW candidate is still more actionable
 * than an unscored one. Contested stays at 0 — it needs disambiguation before it
 * needs ranking, which is the shipped behaviour.
 *
 * #2578 follow-up — the product owner's "sort by confidence then recency" ask is
 * already this: `loadNewsQueue` ranks Pending by this table first (tier
 * descending) and breaks ties by `publishedAt` descending within a tier (see the
 * comparator below). Introducing the scored BODY tier changes WHICH rows carry
 * HIGH/MEDIUM/LOW, not this table or the comparator — `likelihood` is still one
 * of the same three strings. No sort-logic change was needed; see
 * tests/unit/news-queue.test.ts for the within-tier recency coverage.
 */
const LIKELIHOOD_RANK: Readonly<Record<string, number>> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * How many rows the read-only history tabs load.
 *
 * ponytail: a flat cap, not pagination. Mentions are never deleted (etl/news
 * upserts, never downgrades), so `published` grows monotonically — the weekly
 * scrape adds to it forever, and a full `NEWS_BACKFILL` lands ~1,200 rows on day
 * one. Uncapped, every one of them is materialised, joined against a scholar
 * IN-list, and serialised into the client-component payload on EVERY visit to
 * the page — including the Pending workflow, which loads all three tabs at once.
 * Pending itself is the working queue and must be complete, so it is uncapped.
 * Upgrade path if comms ever needs the deep history: a cursor on
 * (publishedAt, id) plus a (status, publishedAt) index — there is no index on
 * `status` today, both existing ones lead with `cwid`.
 */
export const NEWS_HISTORY_LIMIT = 500;

/**
 * Mentions in `status`, grouped by the detected name they came from.
 *
 * NOT filtered to `source: "NAME"`. Pending is name-only by construction (a VIVO
 * link publishes straight away and never sits pending), but the history statuses
 * must show BOTH sources: a scholar with only VIVO-published mentions on their
 * profile would otherwise appear nowhere in the queue at all. A VIVO row has a
 * null `sourceRef`, so it groups alone under `id:<id>` and is never contested.
 *
 * Ordering: Pending puts confident single matches (HIGH, uncontested) first and
 * sinks contested groups (they need human disambiguation). The history tabs skip
 * that rank entirely — VIVO rows have a null likelihood and would rank 0, burying
 * them under every NAME approval. Both then sort most-recent article first, with
 * `createdAt` breaking the final tie for a deterministic order.
 *
 * The loader is NOT parameterised by sort. The reviewer's sort selector is
 * applied client-side over these groups via `sortNewsQueueGroups`, whose
 * "certainty" branch IS this default order — re-sorting ~1,371 already-loaded
 * groups costs nothing, and a sort param would mean a server round-trip plus a
 * second (status, …) index the table does not have.
 */
export async function loadNewsQueue(
  client: NewsQueueClient,
  status: NewsMentionStatus = "pending",
): Promise<NewsQueueGroup[]> {
  // Pending is the working queue: complete, oldest-first. History is capped, so
  // it must order newest-first at the DB or the cap would keep the oldest rows.
  const isHistory = status !== "pending";
  const rows = await client.newsMention.findMany({
    where: { status },
    orderBy: isHistory
      ? [{ publishedAt: "desc" }, { createdAt: "desc" }]
      : { createdAt: "asc" },
    ...(isHistory ? { take: NEWS_HISTORY_LIMIT } : {}),
    select: {
      id: true,
      cwid: true,
      url: true,
      title: true,
      publishedAt: true,
      detectedName: true,
      likelihood: true,
      matchBasis: true,
      contextSnippet: true,
      showOnProfile: true,
      enteredByCwid: true,
      source: true,
      sourceRef: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (rows.length === 0) return [];

  // Both follow-up reads are keyed on DISTINCT cwids, not rows: Pending carries
  // ~1,371 mentions but far fewer distinct scholars, so deduping first is the
  // difference between a handful of bounded `IN` queries and a per-row lookup.
  // Do NOT "optimise" this back into a lookup inside the row map.
  const mentionCwids = [...new Set(rows.map((r) => r.cwid))];
  // The DECIDER is usually a comms steward, who is generally NOT one of the
  // queue's own scholars — so the name read covers both sets, rather than paying
  // for a second query to resolve `entered_by_cwid`.
  const actorCwids = rows.map((r) => r.enteredByCwid).filter((c): c is string => c !== null);

  // One query for every scholar, not one per row.
  const [scholars, prominenceByCwid] = await Promise.all([
    client.scholar.findMany({
      where: { cwid: { in: [...new Set([...mentionCwids, ...actorCwids])] } },
      select: {
        cwid: true,
        slug: true,
        preferredName: true,
        postnominal: true,
        fullName: true,
        roleCategory: true,
        primaryTitle: true,
        primaryDepartment: true,
      },
    }),
    // Scoped to the MENTIONED scholars only — an actor's prominence is not a
    // queue-ordering input.
    computeProminence(client, mentionCwids),
  ]);
  const byCwid = new Map(scholars.map((s) => [s.cwid, s]));

  // Group by detected-name line. A NULL sourceRef is its own group keyed by id,
  // never lumped with other NULLs (which would falsely mark rows as competing).
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.sourceRef ?? `id:${r.id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }

  const out: NewsQueueGroup[] = [];
  for (const [key, groupRows] of groups) {
    const cwids = groupRows.map((r) => r.cwid);
    const contested = new Set(cwids).size > 1;
    out.push({
      key,
      contested,
      detectedName: groupRows[0].detectedName,
      rows: groupRows.map((r) => {
        const s = byCwid.get(r.cwid);
        const preferred = s?.preferredName ?? s?.fullName ?? r.cwid;
        const score = prominenceByCwid.get(r.cwid);
        // Same preferred-name fallback as `scholarName`, minus the postnominal:
        // this is a "who decided this" byline, not the published profile name.
        const actor = r.enteredByCwid === null ? null : byCwid.get(r.enteredByCwid);
        return {
          id: r.id,
          cwid: r.cwid,
          slug: s?.slug ?? null,
          scholarName: formatPublishedName(
            preferred,
            s?.postnominal ?? null,
            s?.roleCategory ?? null,
          ),
          roleLabel: formatRoleCategory(s?.roleCategory ?? null),
          roleCategory: s?.roleCategory ?? null,
          title: s?.primaryTitle ?? null,
          department: s?.primaryDepartment ?? null,
          articleTitle: r.title,
          articleUrl: r.url,
          publishedAt: r.publishedAt ? r.publishedAt.toISOString().slice(0, 10) : null,
          detectedName: r.detectedName,
          likelihood: r.likelihood,
          matchBasis: r.matchBasis,
          contextSnippet: r.contextSnippet,
          contextSnippetMatches: snippetMatchRanges(r.contextSnippet, r.detectedName),
          source: r.source,
          sourceRef: r.sourceRef,
          createdAt: r.createdAt.toISOString(),
          decidedAt: r.updatedAt.toISOString(),
          competingCwids: contested ? cwids.filter((c) => c !== r.cwid) : [],
          showOnProfile: r.showOnProfile,
          prominence: score?.prominence ?? 0,
          leadershipTier: score?.leadershipTier ?? LEADERSHIP_TIER.none,
          declinedByScholar: status === "rejected" && r.enteredByCwid === r.cwid,
          decidedByName:
            r.enteredByCwid === null
              ? null
              : (actor?.preferredName ?? actor?.fullName ?? r.enteredByCwid),
        };
      }),
    });
  }

  // Pending gets the likelihood rank ("certainty", the shipped default order);
  // history must not (a VIVO row's null likelihood would rank 0 and bury it).
  return status === "pending" ? sortNewsQueueGroups(out, "certainty") : out.sort(compareRecency);
}

/**
 * The reviewer-selectable orderings for the loaded groups.
 *
 *  - "certainty" — the DEFAULT and the shipped pending order: likelihood rank
 *    first (contested sunk to 0), then most-recent article. Do not change it.
 *  - "recent" — pure recency, no likelihood weighting: "what did the newsroom
 *    just publish", regardless of how confident the match is.
 *  - "prominence" — leadership tier then prominence: triage the Dean's mentions
 *    before a postdoc's when the queue is 1,300 rows deep.
 */
export type NewsQueueSort = "certainty" | "recent" | "prominence";

/** Most-recent article first; a null `publishedAt` always sinks. 0 when tied,
 *  so each caller adds its own `createdAt` tie-break. */
function comparePublished(a: NewsQueueGroup, b: NewsQueueGroup): number {
  const ad = a.rows[0].publishedAt;
  const bd = b.rows[0].publishedAt;
  if (ad === bd) return 0;
  if (ad === null) return 1;
  if (bd === null) return -1;
  return bd.localeCompare(ad);
}

/** The shipped recency tail, shared by "certainty" and the history tabs:
 *  newest article first, `createdAt` ASC breaking the final tie. */
function compareRecency(a: NewsQueueGroup, b: NewsQueueGroup): number {
  return comparePublished(a, b) || a.rows[0].createdAt.localeCompare(b.rows[0].createdAt);
}

/** The shipped PENDING order — likelihood rank, contested forced to 0, then
 *  recency. This is the one comparator `loadNewsQueue` has always applied. */
function compareCertainty(a: NewsQueueGroup, b: NewsQueueGroup): number {
  const ra = a.contested ? 0 : (LIKELIHOOD_RANK[a.rows[0].likelihood ?? ""] ?? 0);
  const rb = b.contested ? 0 : (LIKELIHOOD_RANK[b.rows[0].likelihood ?? ""] ?? 0);
  if (ra !== rb) return rb - ra;
  return compareRecency(a, b);
}

/** Pure recency: no likelihood weighting at all, `createdAt` DESC on a tie (the
 *  newest row wins here, unlike "certainty"'s stable oldest-first tail). */
function compareRecent(a: NewsQueueGroup, b: NewsQueueGroup): number {
  return comparePublished(a, b) || b.rows[0].createdAt.localeCompare(a.rows[0].createdAt);
}

/** A contested group is ranked by its BEST candidate, not `rows[0]`: the group
 *  exists precisely because we don't know which scholar it belongs to, and a
 *  group that might be the Dean deserves the Dean's place in the queue. */
function bestTier(g: NewsQueueGroup): number {
  return Math.min(...g.rows.map((r) => r.leadershipTier));
}
function bestProminence(g: NewsQueueGroup): number {
  return Math.max(...g.rows.map((r) => r.prominence));
}

/** Leadership tier (0 ranks highest) then prominence, falling back to the
 *  certainty order so equally-prominent groups keep the default sequence. */
function compareProminence(a: NewsQueueGroup, b: NewsQueueGroup): number {
  return (
    bestTier(a) - bestTier(b) ||
    bestProminence(b) - bestProminence(a) ||
    compareCertainty(a, b)
  );
}

/**
 * Re-order loaded groups for the queue's sort selector. Returns a NEW array —
 * the client holds the loader's groups across tab switches, so sorting in place
 * would mutate state React is still rendering from.
 */
export function sortNewsQueueGroups(
  groups: NewsQueueGroup[],
  sort: NewsQueueSort,
): NewsQueueGroup[] {
  const cmp =
    sort === "recent"
      ? compareRecent
      : sort === "prominence"
        ? compareProminence
        : compareCertainty;
  return [...groups].sort(cmp);
}

/** Count pending mentions — the admin sub-nav's pending-count pill. */
export function countPendingNews(client: Pick<PrismaClient, "newsMention">): Promise<number> {
  return client.newsMention.count({ where: { status: "pending" } });
}
