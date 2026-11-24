/**
 * Health authorities whose NCBI Bookshelf documents count as an "authority"
 * citation (decided 2026-11-24): WHO including IARC, NICE, CDC, AHRQ and the
 * National Academies. Everything else on Bookshelf is dropped, which is what
 * keeps the textbooks out: about half the books citing a WCM paper are
 * StatPearls, Endotext and GeneReviews.
 *
 * Matched as a substring of the book's publication statement, e.g.
 * "Geneva: World Health Organization; 2018 Jul."
 */
export const ISSUING_BODIES: ReadonlyArray<readonly [publisher: string, body: string]> = [
  ["World Health Organization", "WHO"],
  ["International Agency for Research on Cancer", "WHO"],
  ["National Institute for Health and Care Excellence", "NICE"],
  // NICE's name before 2013.
  ["National Institute for Health and Clinical Excellence", "NICE"],
  ["Centers for Disease Control and Prevention", "CDC"],
  ["Agency for Healthcare Research and Quality", "AHRQ"],
  ["National Academies Press", "National Academies"],
];

/** The authority that issued a Bookshelf book, or null if it is not one. */
export function issuingBody(publicationStatement: string): string | null {
  return ISSUING_BODIES.find(([publisher]) => publicationStatement.includes(publisher))?.[1] ?? null;
}
