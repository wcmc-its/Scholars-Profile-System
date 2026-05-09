/**
 * Taxonomy-match callout pipeline for /search.
 *
 * Given a query string, return curated taxonomy entities whose names
 * substring-match the query (case-insensitive, punctuation-stripped).
 * v1 scope is parent topics + subtopics only; departments / divisions /
 * centers are deferred per issue #14 descope.
 *
 * Match rules:
 *   1. Normalize: lowercase + strip non-alphanumeric. Handles
 *      "Cardio-oncology" / "cardio oncology" / "cardiooncology".
 *   2. Substring match: normalized query is a substring of normalized
 *      Topic.label or Subtopic.displayName ?? label. Subtopics match
 *      on the UI-stylized displayName (short, ~3-6 words) for
 *      precision; the autocomplete suggester uses Subtopic.label for
 *      recall, but the callout is a "curated page exists" affordance
 *      where false positives hurt more than misses.
 *   3. Suppress when normalized query is shorter than 3 chars, or when
 *      nothing matches.
 *
 * Ranking (primary + secondary order):
 *   1. Entity type: parentTopic before subtopic.
 *   2. scholarCount descending. Within a tier this favors the umbrella
 *      topic when several siblings substring-match a broad query — for
 *      "cancer" the user wants "Cancer Biology (General)" first, not
 *      the highest-similarity sibling like "Lung Cancer". (Issue #74.)
 *   3. String similarity descending (query length / label length) as
 *      a tiebreaker when scholar counts are equal.
 *   4. Name ascending (locale-aware) as final tiebreaker.
 *
 * The first ranked match is the "primary" — the row that always renders.
 * Subsequent matches are "secondary," surfaced behind the disclosure
 * affordance in the callout. Cap is 4 visible secondary rows + optional
 * overflow row when secondary.length > 4.
 *
 * Counts are computed on demand for matched entities only. To bound
 * cost on common substring queries (e.g. "cancer" → many hits), the
 * candidate set is capped at MATCH_HARD_CAP before count enrichment;
 * any extras roll into the overflow count.
 */
import { prisma } from "@/lib/db";

const MIN_QUERY_LEN = 3;
const SECONDARY_CAP = 4;
/** Cap candidates considered before enrichment. Anything beyond this rolls
 *  into the overflow count without being individually counted/ranked. */
const MATCH_HARD_CAP = 1 + SECONDARY_CAP + 20;

export type TaxonomyMatch = {
  entityType: "parentTopic" | "subtopic";
  id: string;
  name: string;
  parentTopicId: string | null;
  parentTopicLabel: string | null;
  href: string;
  scholarCount: number;
  publicationCount: number;
  /** Length-normalized substring overlap, in [0, 1]. */
  similarity: number;
};

export type TaxonomyMatchResult =
  | { state: "none" }
  | {
      state: "matches";
      primary: TaxonomyMatch;
      secondary: TaxonomyMatch[];
      /** Count of secondary matches that didn't fit inline (secondary.length > SECONDARY_CAP). */
      overflowCount: number;
      /** Original query, used for the overflow link target. */
      query: string;
    };

/**
 * Lowercase + strip non-alphanumeric. Handles "Cardio-oncology" ↔
 * "cardio oncology" ↔ "cardiooncology" without stemming.
 */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

type EntityCandidate = {
  entityType: "parentTopic" | "subtopic";
  id: string;
  /** Visible name. Topics use label; subtopics use displayName ?? label. */
  name: string;
  /** Match haystack — Topic.label or Subtopic.label, normalized. */
  matchKey: string;
  parentTopicId: string | null;
  parentTopicLabel: string | null;
};

async function loadEntityCandidates(): Promise<EntityCandidate[]> {
  const [topics, subtopics] = await Promise.all([
    prisma.topic.findMany({ select: { id: true, label: true } }),
    prisma.subtopic.findMany({
      select: {
        id: true,
        label: true,
        displayName: true,
        parentTopicId: true,
        parentTopic: { select: { label: true } },
      },
    }),
  ]);

  const out: EntityCandidate[] = [];
  for (const t of topics) {
    const key = normalizeForMatch(t.label);
    if (!key) continue;
    out.push({
      entityType: "parentTopic",
      id: t.id,
      name: t.label,
      matchKey: key,
      parentTopicId: null,
      parentTopicLabel: null,
    });
  }
  for (const s of subtopics) {
    const display = s.displayName?.trim() || s.label;
    const matchKey = normalizeForMatch(display);
    if (!matchKey) continue;
    out.push({
      entityType: "subtopic",
      id: s.id,
      name: display,
      matchKey,
      parentTopicId: s.parentTopicId,
      parentTopicLabel: s.parentTopic?.label ?? null,
    });
  }
  return out;
}

async function getCounts(
  candidate: EntityCandidate,
): Promise<{ scholarCount: number; publicationCount: number }> {
  if (candidate.entityType === "parentTopic") {
    const [scholars, pubs] = await Promise.all([
      prisma.publicationTopic.groupBy({
        by: ["cwid"],
        where: {
          parentTopicId: candidate.id,
          scholar: { deletedAt: null, status: "active" },
        },
      }),
      prisma.publicationTopic.groupBy({
        by: ["pmid"],
        where: { parentTopicId: candidate.id },
      }),
    ]);
    return { scholarCount: scholars.length, publicationCount: pubs.length };
  }
  const [scholars, pubs] = await Promise.all([
    prisma.publicationTopic.groupBy({
      by: ["cwid"],
      where: {
        primarySubtopicId: candidate.id,
        scholar: { deletedAt: null, status: "active" },
      },
    }),
    prisma.publicationTopic.groupBy({
      by: ["pmid"],
      where: { primarySubtopicId: candidate.id },
    }),
  ]);
  return { scholarCount: scholars.length, publicationCount: pubs.length };
}

function buildHref(candidate: EntityCandidate): string {
  if (candidate.entityType === "parentTopic") {
    return `/topics/${candidate.id}`;
  }
  const params = new URLSearchParams({ subtopic: candidate.id });
  return `/topics/${candidate.parentTopicId}?${params.toString()}`;
}

function rank(matches: TaxonomyMatch[]): TaxonomyMatch[] {
  const typePriority = (t: TaxonomyMatch["entityType"]) =>
    t === "parentTopic" ? 0 : 1;
  return matches.slice().sort((a, b) => {
    const t = typePriority(a.entityType) - typePriority(b.entityType);
    if (t !== 0) return t;
    // Issue #74 — within a tier, prefer the broader topic when several
    // sibling labels substring-match a broad query. scholarCount is the
    // best available proxy for "umbrella vs. specific subtype": for
    // "cancer", "Cancer Biology (General)" carries more scholars than
    // "Lung Cancer" or "Breast Cancer" and lands first. Narrow queries
    // ("lung cancer") only substring-match a single parent so the
    // tie-break never fires.
    const c = b.scholarCount - a.scholarCount;
    if (c !== 0) return c;
    const sim = b.similarity - a.similarity;
    if (sim !== 0) return sim;
    return a.name.localeCompare(b.name);
  });
}

export async function matchQueryToTaxonomy(
  query: string,
): Promise<TaxonomyMatchResult> {
  const trimmed = query.trim();
  const normalized = normalizeForMatch(trimmed);
  if (normalized.length < MIN_QUERY_LEN) return { state: "none" };

  const all = await loadEntityCandidates();
  const matched = all
    .filter((c) => c.matchKey.includes(normalized))
    .map((c) => ({
      ...c,
      similarity: normalized.length / c.matchKey.length,
    }));
  if (matched.length === 0) return { state: "none" };

  // Pre-rank by [type priority, similarity desc] before the hard cap so the
  // best candidates make it through to count enrichment regardless of how
  // many low-similarity matches the query produced.
  const typePriority = (t: EntityCandidate["entityType"]) =>
    t === "parentTopic" ? 0 : 1;
  matched.sort((a, b) => {
    const t = typePriority(a.entityType) - typePriority(b.entityType);
    if (t !== 0) return t;
    return b.similarity - a.similarity;
  });

  // Cap candidates before count enrichment. Excess rolls into overflow so
  // we don't pay for N count queries on common substring matches.
  const considered = matched.slice(0, MATCH_HARD_CAP);
  const cappedExtra = matched.length - considered.length;

  const enriched = await Promise.all(
    considered.map(async (c) => {
      const counts = await getCounts(c);
      const match: TaxonomyMatch = {
        entityType: c.entityType,
        id: c.id,
        name: c.name,
        parentTopicId: c.parentTopicId,
        parentTopicLabel: c.parentTopicLabel,
        href: buildHref(c),
        scholarCount: counts.scholarCount,
        publicationCount: counts.publicationCount,
        similarity: c.similarity,
      };
      return match;
    }),
  );

  const ranked = rank(enriched);
  const [primary, ...rest] = ranked;
  const visibleSecondary = rest.slice(0, SECONDARY_CAP);
  const overflowCount =
    Math.max(0, rest.length - SECONDARY_CAP) + cappedExtra;

  return {
    state: "matches",
    primary,
    secondary: visibleSecondary,
    overflowCount,
    query: trimmed,
  };
}
