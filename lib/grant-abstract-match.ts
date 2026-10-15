/**
 * #3071 — is a grant's abstract plausibly ABOUT its title?
 *
 * RePORTER abstract enrichment keys on the award number, so an InfoEd row with
 * the wrong award number carries another project's abstract (an unrelated R01,
 * or the parent center's core or network summary). The abstract then no longer
 * describes the grant, and anything derived from it follows: area scores today,
 * the feed's abstract expand later.
 *
 * The check is deliberately cheap and deterministic: the share of the title's
 * content words that also appear in the abstract. A real abstract restates its
 * title's subject almost word for word; another project's abstract shares a
 * word or two by chance. Pure, no imports, safe in a client bundle.
 *
 * It is deliberately lenient: a 5-char prefix counts as the same word, and the
 * cut sits low, so it mostly catches abstracts that share no title word at all.
 * A wrong abstract that happens to share a few title words still passes.
 *
 * Calibrated on the 820 abstract-bearing grants of the area-signals pilot export
 * (local, not committed): 10 fall under the cutoff (1.2%), every one a
 * consortium/center/network summary or an unrelated project, apart from one
 * cohort title whose abstract uses synonyms for all but one title word. The
 * nearest correct abstracts sit at 1/6 and 1/5 of title words, above the cut.
 */

/** Drop when fewer than this share of the title's content words are in the abstract. */
export const ABSTRACT_TITLE_MIN_OVERLAP = 0.15;

/** Titles with fewer content words than this are too short to judge: always a match. */
export const ABSTRACT_TITLE_MIN_TOKENS = 3;

/** Shared leading characters that count as the same word (regulation ~ regulatory). */
const PREFIX_LEN = 5;

/**
 * Function words plus the generic grant vocabulary that says nothing about the
 * subject ("a novel approach", "project", "core"). Words under three characters
 * are dropped before this list applies.
 */
const STOPWORDS = new Set(
  (
    "and are as at be by for from has have in into is it its of on or that the their this to was " +
    "were with within without via vs versus using use based between among through toward towards " +
    "during under over after before across new novel study studies role roles project program " +
    "research mechanism mechanisms approach approaches development targeting core"
  ).split(" "),
);

function contentTokens(s: string): string[] {
  return (
    s
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

export type AbstractTitleOverlap = {
  /** Distinct title content words. */
  titleTokens: number;
  /** How many of them the abstract contains (exact, or same 5-char prefix). */
  matched: number;
};

export function abstractTitleOverlap(title: string, abstract: string): AbstractTitleOverlap {
  const titleWords = [...new Set(contentTokens(title))];
  const abstractWords = new Set(contentTokens(abstract));
  const prefixes = new Set([...abstractWords].map((w) => w.slice(0, PREFIX_LEN)));
  const matched = titleWords.filter(
    (w) => abstractWords.has(w) || (w.length >= PREFIX_LEN && prefixes.has(w.slice(0, PREFIX_LEN))),
  ).length;
  return { titleTokens: titleWords.length, matched };
}

/**
 * False only when the abstract is judged to belong to another project. An empty
 * abstract, or a title too short to judge, is a match: there is nothing to hide.
 */
export function grantAbstractMatchesTitle(
  title: string | null | undefined,
  abstract: string | null | undefined,
): boolean {
  if (!abstract || abstract.trim().length === 0) return true;
  const { titleTokens, matched } = abstractTitleOverlap(title ?? "", abstract);
  if (titleTokens < ABSTRACT_TITLE_MIN_TOKENS) return true;
  return matched / titleTokens >= ABSTRACT_TITLE_MIN_OVERLAP;
}
