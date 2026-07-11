/**
 * CTL sponsor match — rank WCM researchers against a pasted sponsor description
 * (`docs/2026-07-09-ctl-technologies-handoff.md` §2).
 *
 * Sponsor interest arrives as an email or a call, not a URL, and the licensing
 * officers' question is purely topical: "who at WCM works on THIS?" So the
 * composition here is relevance-weighted Variant-B and nothing else:
 *
 *   score(paper) = scorePublication(top_scholars, scholar-centric) × rel(pmid)
 *
 * where `rel` is one BM25 round-trip over title^2/abstract for the pasted text
 * (`relevanceScoresForQuery`), normalized to the query's own max. Papers absent
 * from the relevance set never enter the pool. Deliberately ABSENT versus the
 * grant reverse matcher (`rankResearchersForOpportunity`): no stageAppeal axis,
 * no ESI demotion, no IP/relevance boosts — a pharma sponsor cares about none
 * of them. The pool applies the same hard gates as the subtopic-grain matcher
 * (first/last author, year ≥ floor, active eligible scholar, non-excluded pub
 * type), folds into ONE synthetic TopicResult (weight 1), and reuses the pure
 * `rankResearchers` core so `topicFit` = defaultScore = Σ weighted Variant-B.
 *
 * Each ranked row also carries EVIDENCE (display only, never scoring inputs):
 * the scholar's top papers by contribution (title + the BM25 relevance that
 * drove the rank) and their matched parent topics — so an officer can see WHY
 * someone ranked, and the client can facet on department/topic/CTL-IP.
 *
 * Double-count hazard: `publication_topic` keys on (pmid, cwid, parentTopicId),
 * so one paper yields one row PER PARENT TOPIC. The subtopic matcher narrows by
 * `primarySubtopicId`; this pool has no such filter, so it dedupes explicitly
 * to one row per (cwid, pmid) — max `score` row — before scoring, or the same
 * paper would be credited several times. (The topic EVIDENCE deliberately reads
 * the raw pre-dedup rows: a paper legitimately counts under each parent topic
 * it carries when the question is "which topics matched", not "how much".)
 */
import { db } from "@/lib/db";
import { TOP_SCHOLARS_ELIGIBLE_ROLES } from "@/lib/eligibility";
import { FEED_EXCLUDED_TYPES } from "@/lib/publication-types";
import { scorePublication, type RankablePublication } from "@/lib/ranking";
import {
  rankResearchers,
  type RankedScholar,
  type ScholarTopicScore,
} from "@/lib/api/match-researchers";
import { relevanceScoresForQuery } from "@/lib/api/search";
import { applyDenseRerank, denseWeight } from "@/lib/api/sponsor-match-dense";

const RECITERAI_YEAR_FLOOR = 2020; // D-15; mirrors lib/api/match-researchers.ts (module-local there).

/** One synthetic topic id for the single TopicResult (weight 1) — the unchanged
 *  downstream renders its pubCount/minYear as the row evidence. */
const SPONSOR_MATCH_TOPIC_ID = "__sponsor_match__";

/** Sponsor emails run a few paragraphs; anything past this is boilerplate that
 *  only degrades the BM25 query. Sliced, not rejected — a long paste still works.
 *  ponytail: 3k chars ≈ 500 tokens × 2 match fields, safely under OpenSearch's
 *  bool max_clause_count; raise only with a clause-safe query shape. */
const MAX_DESCRIPTION_CHARS = 3_000;

/** Long list on purpose (was 25): the client facets (department / topic /
 *  CTL-IP) narrow it browser-side, so the server returns enough rows for
 *  narrowing to be worth doing. */
const DEFAULT_LIMIT = 100;

/** Top-N papers and topics attached per row as "why this person ranked" evidence. */
const TOP_EVIDENCE_ROWS = 3;

/** Master switch (default off) — gates the page, the route, and the subnav tab. */
export function isSponsorMatchEnabled(): boolean {
  return process.env.SPONSOR_MATCH === "on";
}

/** One evidence paper on a ranked row: PubMed-linkable, with the normalized
 *  BM25 relevance ((0–1], query-max-normalized) that weighted its contribution. */
export type SponsorMatchPaper = {
  pmid: string;
  title: string;
  year: number | null;
  journal: string | null;
  relevance: number;
};

/** One matched parent topic on a ranked row (pubCount = this scholar's matching
 *  papers carrying the topic). */
export type SponsorMatchTopic = { topicId: string; label: string; pubCount: number };

/** RankedScholar + the sponsor-console evidence fields (display only, never
 *  scoring inputs). */
export type SponsorRankedScholar = RankedScholar & {
  topPapers: SponsorMatchPaper[];
  matchedTopics: SponsorMatchTopic[];
};

/** Trust-boundary normalization: strip control chars (tab/newline survive as
 *  whitespace), collapse to a trimmed string, cap the length. "" ⇒ no query. */
function normalizeDescription(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw
    // Escaped ranges, never literal control bytes in source (the #1602 binary-diff trap).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}

/**
 * Rank researchers by topical fit against a pasted sponsor description.
 * Empty/whitespace input or an empty relevance set short-circuits to `[]`
 * (no OpenSearch / MySQL round-trips for a blank paste). Title/department,
 * `technologyCount` (CTL officers care whether the researcher already holds
 * CTL IP), `topPapers`, and `matchedTopics` are attached post-ranking, exactly
 * as `rankResearchersForOpportunity` does — display fields, never scoring
 * inputs.
 */
export async function rankResearchersForDescription(
  description: string,
  opts: { limit?: number; now?: Date } = {},
): Promise<SponsorRankedScholar[]> {
  const now = opts.now ?? new Date();
  const text = normalizeDescription(description);
  if (text.length === 0) return [];

  const rel = await relevanceScoresForQuery([{ q: text }], 1000);
  if (rel.size === 0) return [];

  const rows = await db.read.publicationTopic.findMany({
    where: {
      pmid: { in: [...rel.keys()] },
      authorPosition: { in: ["first", "last"] },
      year: { gte: RECITERAI_YEAR_FLOOR },
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: { in: [...TOP_SCHOLARS_ELIGIBLE_ROLES] },
      },
      publication: { publicationType: { notIn: [...FEED_EXCLUDED_TYPES] } },
    },
    include: {
      scholar: { select: { cwid: true, slug: true, preferredName: true } },
      publication: { select: { pmid: true, publicationType: true, dateAddedToEntrez: true } },
    },
  });

  // Topic EVIDENCE from the RAW rows (pre-dedup, see module doc): which parent
  // topics does each scholar's matching work sit in, and over how many papers.
  const topicPmidsByCwid = new Map<string, Map<string, Set<string>>>();
  for (const r of rows) {
    const byTopic = topicPmidsByCwid.get(r.cwid) ?? new Map<string, Set<string>>();
    const pmids = byTopic.get(r.parentTopicId) ?? new Set<string>();
    pmids.add(r.pmid);
    byTopic.set(r.parentTopicId, pmids);
    topicPmidsByCwid.set(r.cwid, byTopic);
  }

  // Dedupe to ONE row per (cwid, pmid) — keep the max-`score` row (see module doc).
  const byCwidPmid = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.cwid}|${r.pmid}`;
    const prev = byCwidPmid.get(key);
    if (!prev || Number(r.score) > Number(prev.score)) byCwidPmid.set(key, r);
  }

  const byScholar = new Map<
    string,
    {
      entry: ScholarTopicScore;
      pmids: Set<string>;
      minYear: number | null;
      /** Per-paper contribution + relevance — kept so the row can show WHY it ranked. */
      papers: Array<{ pmid: string; inc: number; rel: number }>;
    }
  >();
  for (const r of byCwidPmid.values()) {
    // ponytail: rankable build mirrors subtopicPoolResults; ~8 lines, not worth a shared helper.
    const rankable: RankablePublication = {
      pmid: r.publication.pmid,
      publicationType: r.publication.publicationType,
      reciteraiImpact: Number(r.score),
      dateAddedToEntrez: r.publication.dateAddedToEntrez,
      authorship: {
        isFirst: r.authorPosition === "first",
        isLast: r.authorPosition === "last",
        isPenultimate: r.authorPosition === "penultimate",
      },
      isConfirmed: true,
    };
    // Relevance-WEIGHTED (not boosted): a paper contributes only in proportion
    // to how well it matches the pasted text. The pool is ⊆ rel's keys, so the
    // `?? 0` is a type-level backstop, not a live path.
    const relForPmid = rel.get(r.pmid) ?? 0;
    const inc = scorePublication(rankable, "top_scholars", true, now) * relForPmid;
    const slot = byScholar.get(r.scholar.cwid) ?? {
      entry: {
        cwid: r.scholar.cwid,
        slug: r.scholar.slug,
        preferredName: r.scholar.preferredName ?? undefined,
        variantBScore: 0,
      },
      pmids: new Set<string>(),
      minYear: null as number | null,
      papers: [] as Array<{ pmid: string; inc: number; rel: number }>,
    };
    slot.entry.variantBScore += inc;
    slot.pmids.add(r.publication.pmid);
    slot.papers.push({ pmid: r.publication.pmid, inc, rel: relForPmid });
    if (r.year != null)
      slot.minYear = slot.minYear == null ? r.year : Math.min(slot.minYear, r.year);
    byScholar.set(r.scholar.cwid, slot);
  }
  if (byScholar.size === 0) return [];

  const ranked = rankResearchers(
    [
      {
        topicId: SPONSOR_MATCH_TOPIC_ID,
        topicWeight: 1,
        scholars: [...byScholar.values()].map((s) => ({
          ...s.entry,
          pubCount: s.pmids.size,
          minYear: s.minYear,
        })),
      },
    ],
    { sort: "fit", limit: opts.limit ?? DEFAULT_LIMIT },
  );

  // Denormalized display fields + evidence, attached post-ranking (never scoring inputs).
  const out: SponsorRankedScholar[] = ranked.map((r) => ({
    ...r,
    topPapers: [],
    matchedTopics: [],
  }));
  const cwids = out.map((r) => r.cwid);
  if (cwids.length > 0) {
    const topPapersByCwid = new Map(
      cwids.map((c) => [
        c,
        (byScholar.get(c)?.papers ?? [])
          .slice()
          .sort((a, b) => b.inc - a.inc)
          .slice(0, TOP_EVIDENCE_ROWS),
      ]),
    );
    const topTopicsByCwid = new Map(
      cwids.map((c) => [
        c,
        [...(topicPmidsByCwid.get(c) ?? new Map<string, Set<string>>())]
          .map(([topicId, pmids]) => ({ topicId, pubCount: pmids.size }))
          .sort((a, b) => b.pubCount - a.pubCount)
          .slice(0, TOP_EVIDENCE_ROWS),
      ]),
    );
    const [scholars, grouped, pubRows, topicRows] = await Promise.all([
      db.read.scholar.findMany({
        where: { cwid: { in: cwids } },
        select: { cwid: true, primaryTitle: true, primaryDepartment: true },
      }),
      db.read.scholarTechnology.groupBy({
        by: ["cwid"],
        where: { cwid: { in: cwids } },
        _count: { _all: true },
      }),
      db.read.publication.findMany({
        where: {
          pmid: { in: [...new Set([...topPapersByCwid.values()].flat().map((p) => p.pmid))] },
        },
        select: { pmid: true, title: true, year: true, journal: true },
      }),
      db.read.topic.findMany({
        where: {
          id: { in: [...new Set([...topTopicsByCwid.values()].flat().map((t) => t.topicId))] },
        },
        select: { id: true, label: true },
      }),
    ]);
    const profileByCwid = new Map(scholars.map((s) => [s.cwid, s]));
    const techByCwid = new Map(grouped.map((g) => [g.cwid, g._count._all]));
    const pubByPmid = new Map(pubRows.map((p) => [p.pmid, p]));
    const labelByTopicId = new Map(topicRows.map((t) => [t.id, t.label]));
    for (const r of out) {
      const p = profileByCwid.get(r.cwid);
      r.title = p?.primaryTitle ?? null;
      r.department = p?.primaryDepartment ?? null;
      r.technologyCount = techByCwid.get(r.cwid) ?? 0;
      r.topPapers = (topPapersByCwid.get(r.cwid) ?? []).flatMap((paper) => {
        const pub = pubByPmid.get(paper.pmid);
        return pub
          ? [
              {
                pmid: paper.pmid,
                title: pub.title,
                year: pub.year,
                journal: pub.journal,
                relevance: paper.rel,
              },
            ]
          : [];
      });
      r.matchedTopics = (topTopicsByCwid.get(r.cwid) ?? []).map((t) => ({
        topicId: t.topicId,
        // Missing label = a drifted topic id (FK'd, so near-impossible); the id
        // is still a readable slug.
        label: labelByTopicId.get(t.topicId) ?? t.topicId,
        pubCount: t.pubCount,
      }));
    }
  }
  // Stage-2 dense re-rank (design §2/§8): reorder the term-retrieved pool by
  // fused (1-w)·terms + w·denseAffinity. wDense=0 (default) is a no-op — no extra
  // queries, order byte-identical to the terms-only path.
  return applyDenseRerank(out, (r) => r.defaultScore, rel, denseWeight(), now);
}
