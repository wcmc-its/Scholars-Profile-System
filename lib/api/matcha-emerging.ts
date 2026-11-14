/**
 * Emerging work in a Matcha search: the WCM conference abstracts and preprints already scored
 * for `/edit/fundable-work` (`fundable_work`, weekly from OpenAlex), matched to the ask.
 *
 * DISPLAY ONLY. Nothing here touches `fusedScore` or rank: whether emerging work should count
 * toward rank belongs with grants-in-ranking, in search, after an eval.
 *
 * Computed by the route at RESPONSE time, not inside the engine, so a stored run replayed next
 * week shows next week's abstracts. Pure: the route hands in the rows; this module has no db.
 *
 * Matching: a work matches a concept when any of the concept's member terms appears in its title
 * or abstract as a whole word. Only `concept`-kind clusters count; a method alone ("flow
 * cytometry") says nothing about the ask's topic. Short all-caps members ("IBD", "CAR") match
 * case-sensitively, so "car" in prose is not CAR-T.
 */
import type {
  MatchaConcept,
  MatchaEmergingItem,
  MatchaEmergingOnAsk,
  MatchaEmergingWork,
} from "@/lib/api/matcha-contract";

/** Items shown per ranked researcher. */
export const EMERGING_PER_PERSON = 3;
/** Items in the "Emerging on this ask" list (authors not in the ranked results). */
export const EMERGING_ON_ASK_MAX = 10;
/** Look-back window, matching the fundable-work ETL's own. */
export const EMERGING_WINDOW_DAYS = 730;

export type EmergingWorkRow = {
  id: string;
  type: string;
  doi: string | null;
  title: string;
  abstract: string;
  venue: string | null;
  publicationDate: Date;
  score: number;
  authors: { cwid: string; scholar: { preferredName: string; slug: string } }[];
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function memberPattern(term: string): RegExp | null {
  const t = term.trim();
  if (t.length < 3) return null;
  const caseSensitive = t.length <= 5 && t === t.toUpperCase() && /[A-Z]/.test(t);
  // \b fails next to non-word characters ("TNF-α", "IL-23"), so bound on "not a letter/digit".
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(t)}(?![\\p{L}\\p{N}])`, caseSensitive ? "u" : "iu");
}

/** The concept terms (cluster representatives) a text matches, in the concepts' order. */
export function matchedConceptTerms(
  text: string,
  concepts: readonly Pick<MatchaConcept, "term" | "kind" | "members">[],
): string[] {
  const out: string[] = [];
  for (const c of concepts) {
    if (c.kind !== "concept") continue;
    const members = c.members.length > 0 ? c.members : [c.term];
    if (members.some((m) => memberPattern(m)?.test(text))) out.push(c.term);
  }
  return out;
}

function toItem(w: EmergingWorkRow, concepts: string[]): MatchaEmergingItem {
  return {
    id: w.id,
    title: w.title,
    type: w.type,
    venue: w.venue,
    date: w.publicationDate.toISOString().slice(0, 10),
    url: w.doi ? `https://doi.org/${w.doi}` : `https://openalex.org/${w.id}`,
    concepts,
  };
}

/** Per ranked researcher, their matching items; plus matching items by people not ranked.
 *  Absent-not-empty: a researcher with no match gets no key, and an empty result is `undefined`. */
export function buildEmergingWork(
  works: readonly EmergingWorkRow[],
  concepts: readonly Pick<MatchaConcept, "term" | "kind" | "members">[],
  rankedCwids: ReadonlySet<string>,
): MatchaEmergingWork | undefined {
  const matched = works
    .map((w) => ({ w, terms: matchedConceptTerms(`${w.title}\n${w.abstract}`, concepts) }))
    .filter((m) => m.terms.length > 0)
    // Most concepts matched first, then newest.
    .sort(
      (a, b) =>
        b.terms.length - a.terms.length ||
        b.w.publicationDate.getTime() - a.w.publicationDate.getTime(),
    );

  const byCwid: Record<string, MatchaEmergingItem[]> = {};
  const onAsk: MatchaEmergingOnAsk[] = [];
  for (const { w, terms } of matched) {
    const item = toItem(w, terms);
    let anyRanked = false;
    for (const a of w.authors) {
      if (!rankedCwids.has(a.cwid)) continue;
      anyRanked = true;
      const list = (byCwid[a.cwid] ??= []);
      if (list.length < EMERGING_PER_PERSON) list.push(item);
    }
    if (!anyRanked && onAsk.length < EMERGING_ON_ASK_MAX && w.authors.length > 0) {
      onAsk.push({
        ...item,
        authors: w.authors.map((a) => ({
          cwid: a.cwid,
          name: a.scholar.preferredName,
          profileSlug: a.scholar.slug,
        })),
      });
    }
  }
  if (Object.keys(byCwid).length === 0 && onAsk.length === 0) return undefined;
  return { byCwid, onAsk };
}
