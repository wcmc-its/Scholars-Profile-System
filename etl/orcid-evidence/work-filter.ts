/**
 * Which ORCID works are publications. The librarian queue (etl/orcid-evidence)
 * runs every record's works through `filterPublicationWorks` before it counts
 * `works_total`, `new_works`, the new-works sample and the shared papers, and
 * the ORCID publication harvest (Phase 2 of the publication lane) reuses it, so
 * the two never disagree about what a "work" is.
 *
 * Dropped (ORCID queue v2 spec, item 3; decision A: figures and images never
 * appear as works):
 *   - work types that are not publications: `image`, `data-set`, `software`,
 *     `lecture-speech`, `conference-poster`, `conference-abstract`, `website`;
 *   - an `other` (or untyped) work with no PMID whose title reads as a figure or
 *     supplement ("Figure 3", "Table S1", "Supplementary material …");
 *   - a Figshare (`10.6084`) or Zenodo (`10.5281`) DOI, unless the work is typed
 *     `journal-article`;
 *   - (v2.1) a supplement, WHATEVER its ORCID type: a title that starts
 *     "Supplementary / Supplemental <material noun> …", or reads
 *     "(Figure|Fig.|Table|Data|Movie|Video|File|Appendix) S?<n>[a-z]? (from|for|of) …"
 *     at its start; and any AACR supplement DOI
 *     (`10.1158/<issn>.<6+ digits>[.vN]`), which Crossref types journal-article.
 *     The title rules still spare a work that carries a PMID.
 * Collapsed: preprint versions. Works that share a title (ignoring case,
 * punctuation, diacritics and a trailing `v1` / `v2`) or a DOI up to its
 * version suffix form one group when the group holds a preprint (type
 * `preprint`, or a preprint-server DOI). The group keeps its published works
 * (or, with none, one preprint: the highest version) and the first kept work
 * takes every id of the works it absorbed, so a scholar's paper matched by the
 * preprint's DOI still counts as the same paper. A group with no preprint is
 * left alone (two "Reply" letters are two works).
 *
 * Pure; no I/O, and no import that builds a client (the harvest imports it too).
 */

/** Diacritics off (the registry's `fold`, inlined to keep this module import-free). */
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export const NON_PUBLICATION_TYPES: ReadonlySet<string> = new Set([
  "image",
  "data-set",
  "software",
  "lecture-speech",
  "conference-poster",
  "conference-abstract",
  "website",
]);

/** Figshare, Zenodo: repository DOIs, dropped unless typed journal-article. */
export const REPOSITORY_DOI_PREFIXES = ["10.6084/", "10.5281/"] as const;

/** Preprint servers' DOI prefixes: bioRxiv/medRxiv, Research Square,
 *  Preprints.org, SSRN, OSF / PsyArXiv / SocArXiv, arXiv, TechRxiv, Authorea,
 *  ChemRxiv. */
export const PREPRINT_DOI_PREFIXES = [
  "10.1101/",
  "10.21203/",
  "10.20944/",
  "10.2139/",
  "10.31219/",
  "10.31234/",
  "10.31235/",
  "10.48550/",
  "10.36227/",
  "10.22541/",
  "10.26434/",
] as const;

/** Titles that name a figure, table or supplement rather than a paper: the
 *  item word must be followed by its number ("Figure 3", "Table S1") or by a
 *  material noun ("Supplementary material …"), so a paper titled "Video-assisted
 *  …" or "Appendix cancer: …" is kept. */
const FIGURE_TITLES: readonly RegExp[] = [
  /^\s*(fig(ure)?s?\.?|table|movie|video|data sheet)\s*S?\d/i,
  /^\s*(supplement(al|ary)?|suppl\.?)\s+(materials?|data|information|info|files?|tables?|figures?|methods|appendix|appendices|videos?|movies?|text|notes?)\b/i,
  /^\s*supporting information\b/i,
  /^\s*additional file\s*\d/i,
  /^\s*moesm\d*\b/i,
  // "Appendix 2", "Appendix S1", "Appendix A" (an uppercase letter alone, so
  // "Appendix cancer" and "Appendix a review" stay); case-sensitive on the letter.
  /^\s*[Aa](ppendix|PPENDIX)\s*(S?\d|[A-Z](?=$|[.:;,)]))/,
];
const isFigureTitle = (title: string) => FIGURE_TITLES.some((re) => re.test(title));

/** v2.1: supplement titles dropped whatever the work's type (AACR deposits its
 *  supplements as journal-articles: "Supplementary Table S1 from …", "Figure S3
 *  from …"). "Supplementary / Supplemental" must be followed by a material noun,
 *  so "Supplemental oxygen …" and "Supplemental Nutrition Assistance Program …"
 *  stay; an item word must open the title and carry its number and a from / for
 *  / of clause, so "… of the Appendix" stays. */
const SUPPLEMENT_TITLES: readonly RegExp[] = [
  /^\s*supplement(ary|al)\s+(online\s+)?(materials?|data|information|info|files?|tables?|figures?|figs?\.?|methods|appendix|appendices|videos?|movies?|text|notes?|references|results|document|digital content)\b/i,
  /^\s*(figure|fig\.?|table|data|movie|video|file|appendix)\s*S?\d+[a-z]?\s+(from|for|of)\s/i,
  /^\s*supplement(ary|al)\s+(figures|tables)\s+S\d+\s*[-\u2013]\s*S\d+\s+from\s/i,
];
const isSupplementTitle = (title: string) => SUPPLEMENT_TITLES.some((re) => re.test(title));

/** AACR supplement DOIs: `10.1158/<ISSN>.<6+ digits>`, optionally `.vN`, and
 *  the Figshare collection form `10.1158/<ISSN>.c.<6+ digits>` (titled "Data
 *  from <article title>", which no title rule can tell from a paper). An AACR
 *  article DOI has letters after the ISSN (`10.1158/0008-5472.CAN-20-1234`). */
export const AACR_SUPPLEMENT_DOI = /^10\.1158\/\d{4}-\d{3}[\dx]\.(c\.)?\d{6,}(\.v\d+)?$/i;

/** Shorter normalized titles never group: too generic to call two works one. */
const MIN_TITLE_KEY = 20;

export type FilterableWork = {
  /** doi:/pmid: keys (`extractWorkIds`). */
  ids: Set<string>;
  title: string | null;
  /** ORCID work type; null when the record gives none. */
  type: string | null;
  doi: string | null;
};

const lowerType = (w: FilterableWork) => w.type?.trim().toLowerCase() || null;
const lowerDoi = (w: FilterableWork) => w.doi?.trim().toLowerCase() || null;

/** True when the work is not a publication (a dropped type, a figure or
 *  supplement, a repository deposit). Pure. */
export function isNonPublicationWork(w: FilterableWork): boolean {
  const type = lowerType(w);
  if (type && NON_PUBLICATION_TYPES.has(type)) return true;
  // A work carrying a PMID is a paper, whatever its title says.
  const hasPmid = [...w.ids].some((k) => k.startsWith("pmid:"));
  if ((type === null || type === "other") && !hasPmid && w.title && isFigureTitle(w.title))
    return true;
  if (!hasPmid && w.title && isSupplementTitle(w.title)) return true;
  const doi = lowerDoi(w);
  if (doi && AACR_SUPPLEMENT_DOI.test(doi)) return true;
  if (doi && type !== "journal-article" && REPOSITORY_DOI_PREFIXES.some((p) => doi.startsWith(p)))
    return true;
  return false;
}

/** Typed `preprint`, or a preprint server's DOI. Pure. */
export function isPreprint(w: FilterableWork): boolean {
  if (lowerType(w) === "preprint") return true;
  const doi = lowerDoi(w);
  return !!doi && PREPRINT_DOI_PREFIXES.some((p) => doi.startsWith(p));
}

/** Title folded, lowercased, punctuation to spaces, a trailing version marker
 *  ("v2", "version 2") removed. Pure. */
export function titleKey(title: string | null): string | null {
  if (!title) return null;
  const k = fold(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+(v|version)\s*\d+\s*$/, "")
    .trim();
  return k.length >= MIN_TITLE_KEY ? k : null;
}

/** A DOI without its version suffix (`…123456v2` → `…123456`). */
const doiFamily = (doi: string | null) => (doi ? doi.replace(/v\d+$/, "") : null);
const doiVersion = (doi: string | null) => Number(/v(\d+)$/.exec(doi ?? "")?.[1] ?? 0);

/**
 * The publications among a record's works: non-publications dropped, preprint
 * versions collapsed (module doc). Order is kept; a kept work that absorbed
 * others is a copy with the union of their ids. Pure.
 */
export function filterPublicationWorks<T extends FilterableWork>(
  works: readonly T[],
): { kept: T[]; dropped: number; collapsed: number } {
  const pubs = works.filter((w) => !isNonPublicationWork(w));
  const dropped = works.length - pubs.length;

  // Union-find over title key and DOI family.
  const parent = pubs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const byKey = new Map<string, number>();
  pubs.forEach((w, i) => {
    const keys = [titleKey(w.title), doiFamily(lowerDoi(w))].filter((k): k is string => !!k);
    for (const k of keys) {
      const seen = byKey.get(k);
      if (seen === undefined) byKey.set(k, i);
      else parent[find(i)] = find(seen);
    }
  });
  const groups = new Map<number, number[]>();
  pubs.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });

  const keep = new Map<number, T>();
  let collapsed = 0;
  for (const members of groups.values()) {
    const preprints = members.filter((i) => isPreprint(pubs[i]!));
    if (members.length === 1 || preprints.length === 0) {
      for (const i of members) keep.set(i, pubs[i]!);
      continue;
    }
    const published = members.filter((i) => !isPreprint(pubs[i]!));
    const survivors =
      published.length > 0
        ? published
        : [
            preprints.reduce((best, i) =>
              doiVersion(lowerDoi(pubs[i]!)) > doiVersion(lowerDoi(pubs[best]!)) ? i : best,
            ),
          ];
    const absorbed = members.filter((i) => !survivors.includes(i));
    collapsed += absorbed.length;
    const head = survivors[0]!;
    const ids = new Set(pubs[head]!.ids);
    for (const i of absorbed) for (const k of pubs[i]!.ids) ids.add(k);
    for (const i of survivors) keep.set(i, i === head ? { ...pubs[i]!, ids } : pubs[i]!);
  }
  const kept = pubs.flatMap((_, i) => (keep.has(i) ? [keep.get(i)!] : []));
  return { kept, dropped, collapsed };
}
