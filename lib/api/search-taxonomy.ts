/**
 * Taxonomy-match callout pipeline for /search.
 *
 * Given a query string, return up to N curated taxonomy entities that
 * exact-match the query (case-insensitive, punctuation-stripped). v1
 * scope is parent topics + subtopics only; departments / divisions /
 * centers are deferred per issue #14 descope.
 *
 * Match rules:
 *   1. Normalize: lowercase, strip non-alphanumeric, collapse whitespace.
 *   2. Exact match against the normalized form of every Topic.label and
 *      Subtopic (displayName ?? label).
 *   3. Suppress when the normalized query is shorter than 3 chars, OR
 *      when nothing matches.
 *
 * Ranking (primary + secondary order):
 *   1. Entity type: parentTopic before subtopic.
 *   2. Within entity type: scholarCount descending.
 *   3. Tiebreaker: name ascending (locale-aware).
 *
 * The first ranked match is the "primary" — the row that always renders.
 * Subsequent matches are "secondary," surfaced behind the disclosure
 * affordance in the callout. Cap is 4 visible secondary rows + optional
 * overflow row when secondary.length > 4.
 *
 * Counts are computed on demand for matched entities only — at most 5
 * candidates × 2 counts = ≤10 small groupBy aggregations per render,
 * parallelized.
 */
import { prisma } from "@/lib/db";

const MIN_QUERY_LEN = 3;
const SECONDARY_CAP = 4;

export type TaxonomyMatch = {
  entityType: "parentTopic" | "subtopic";
  id: string;
  name: string;
  parentTopicId: string | null;
  parentTopicLabel: string | null;
  href: string;
  scholarCount: number;
  publicationCount: number;
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
  name: string;
  parentTopicId: string | null;
  parentTopicLabel: string | null;
};

async function loadEntityIndex(): Promise<Map<string, EntityCandidate[]>> {
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

  const index = new Map<string, EntityCandidate[]>();
  function add(key: string, entry: EntityCandidate) {
    const bucket = index.get(key);
    if (bucket) bucket.push(entry);
    else index.set(key, [entry]);
  }

  for (const t of topics) {
    const key = normalizeForMatch(t.label);
    if (!key) continue;
    add(key, {
      entityType: "parentTopic",
      id: t.id,
      name: t.label,
      parentTopicId: null,
      parentTopicLabel: null,
    });
  }
  for (const s of subtopics) {
    const display = s.displayName?.trim() || s.label;
    const key = normalizeForMatch(display);
    if (!key) continue;
    add(key, {
      entityType: "subtopic",
      id: s.id,
      name: display,
      parentTopicId: s.parentTopicId,
      parentTopicLabel: s.parentTopic?.label ?? null,
    });
  }
  return index;
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
    const c = b.scholarCount - a.scholarCount;
    if (c !== 0) return c;
    return a.name.localeCompare(b.name);
  });
}

export async function matchQueryToTaxonomy(
  query: string,
): Promise<TaxonomyMatchResult> {
  const trimmed = query.trim();
  const normalized = normalizeForMatch(trimmed);
  if (normalized.length < MIN_QUERY_LEN) return { state: "none" };

  const index = await loadEntityIndex();
  const candidates = index.get(normalized);
  if (!candidates || candidates.length === 0) return { state: "none" };

  const enriched = await Promise.all(
    candidates.map(async (c) => {
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
      };
      return match;
    }),
  );

  const ranked = rank(enriched);
  const [primary, ...rest] = ranked;
  const visibleSecondary = rest.slice(0, SECONDARY_CAP);
  const overflowCount = Math.max(0, rest.length - SECONDARY_CAP);

  return {
    state: "matches",
    primary,
    secondary: visibleSecondary,
    overflowCount,
    query: trimmed,
  };
}
