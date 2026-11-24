/**
 * Byline evidence for `etl/orcid-evidence`: the papers that print a candidate iD
 * next to the scholar's own name. The rows are reciterdb's: PubMed's ORCID on the
 * author entry ReCiter marks as the person (`person_article_author.targetAuthor`),
 * with ReCiter's assertion on the paper (`person_article.userAssertion`). It is
 * the one evidence an empty ORCID record still has.
 *
 * Pure: the read is `loadBylineRows` in index.ts.
 */
import type { ReciterAssertion } from "./index";

export type BylineRow = {
  cwid: string;
  pmid: string;
  orcid: string;
  assertion: ReciterAssertion;
};

/** iD → LOWERCASE cwid → PMID → ReCiter's assertion on that paper. */
export type BylineIndex = {
  byOrcid: Map<string, Map<string, Map<string, ReciterAssertion>>>;
  byCwid: Map<string, Set<string>>;
};

export type BylineFacts = {
  /** Accepted papers that print the iD on the scholar's byline, newest PMID first. */
  papers: string[];
  /** Rejected papers that print it there. */
  rejected: number;
  /** Other people with an accepted paper that prints the same iD on THEIR byline,
   *  or with the iD on file. */
  otherHolders: string[];
  /** Other iDs on the scholar's own accepted bylines. */
  otherIds: string[];
};

/** Accepted byline papers that make a match Strong on their own. */
export const MIN_BYLINE_STRONG = 2;

// The rejection is kept: an old ACCEPTED row must not hide it.
const RANK = { REJECTED: 0, ACCEPTED: 1, PENDING: 2 } as const;

/** The rows by iD and by person. Left out: other institutions' cohorts (a uid with
 *  "_"), and any pair a librarian ruled out (`dismissed`: `cwid|orcid`, the iD as
 *  printed or its primary), which is then neither the person's other iD nor a rival
 *  claim. A deprecated iD counts as the primary it was merged into. Two rows for one
 *  paper: REJECTED beats ACCEPTED beats pending. Pure. */
export function indexBylines(
  rows: readonly BylineRow[],
  opts: {
    dismissed?: ReadonlySet<string>;
    deprecated?: ReadonlyMap<string, string | null>;
  } = {},
): BylineIndex {
  const dismissed = new Set([...(opts.dismissed ?? [])].map((k) => k.toLowerCase()));
  const index: BylineIndex = { byOrcid: new Map(), byCwid: new Map() };
  for (const r of rows) {
    const cwid = r.cwid.trim().toLowerCase();
    const orcid = opts.deprecated?.get(r.orcid) ?? r.orcid;
    const ruledOut = (o: string) => dismissed.has(`${cwid}|${o}`.toLowerCase());
    if (!cwid || cwid.includes("_") || ruledOut(r.orcid) || ruledOut(orcid)) continue;
    const people = index.byOrcid.get(orcid) ?? new Map<string, Map<string, ReciterAssertion>>();
    const papers = people.get(cwid) ?? new Map<string, ReciterAssertion>();
    const prev = papers.get(r.pmid);
    if (!prev || RANK[r.assertion] < RANK[prev]) papers.set(r.pmid, r.assertion);
    people.set(cwid, papers);
    index.byOrcid.set(orcid, people);
    index.byCwid.set(cwid, (index.byCwid.get(cwid) ?? new Set()).add(orcid));
  }
  return index;
}

const accepted = (papers: Map<string, ReciterAssertion> | undefined) =>
  [...(papers ?? [])].filter(([, a]) => a === "ACCEPTED").map(([pmid]) => pmid);

/** iD → the people who have it on file, a deprecated iD counted as its primary. Pure. */
export function heldByOrcid(
  scholars: ReadonlyArray<{ cwid: string; orcid: string | null; deletedAt: Date | null }>,
  deprecated: ReadonlyMap<string, string | null>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of scholars) {
    if (!s.orcid || s.deletedAt) continue;
    const orcid = deprecated.get(s.orcid) ?? s.orcid;
    out.set(orcid, [...(out.get(orcid) ?? []), s.cwid]);
  }
  return out;
}

/** What the bylines say about one (scholar, iD) pair. `heldBy`: who has the iD on
 *  file. Pure. */
export function bylineFactsOf(
  index: BylineIndex,
  cwid: string,
  orcid: string,
  heldBy: readonly string[] = [],
): BylineFacts {
  const me = cwid.toLowerCase();
  const people = index.byOrcid.get(orcid);
  const mine = people?.get(me);
  return {
    papers: accepted(mine).sort((a, b) => Number(b) - Number(a)),
    rejected: [...(mine?.values() ?? [])].filter((a) => a === "REJECTED").length,
    otherHolders: [
      ...new Set([
        ...[...(people ?? [])].filter(([, ps]) => accepted(ps).length > 0).map(([c]) => c),
        ...heldBy.map((c) => c.toLowerCase()),
      ]),
    ]
      .filter((c) => c !== me)
      .sort(),
    otherIds: [...(index.byCwid.get(me) ?? [])]
      .filter((o) => o !== orcid && accepted(index.byOrcid.get(o)?.get(me)).length > 0)
      .sort(),
  };
}
