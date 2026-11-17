/**
 * `/edit/research-security` — loaders and the pure count rules.
 *
 * The four `research_security_*` tables are a nightly copy of reciterdb's
 * watch-list screen (`etl/research-security`). The loader narrows them in SQL
 * by the filters that are cheap there (list, category, publication date,
 * consortium size); everything a number on the page depends on is a pure
 * function over the loaded facts, tested in
 * `tests/unit/research-security-report.test.ts`.
 *
 * Rules that hold in every view:
 * - A CONFIRMED count never includes a pending or review-queue row.
 * - Country of concern is its own tier. The list filter is single-choice
 *   (`ListFilter`), so a country-of-concern match can never be added to an
 *   entity-list total; it is counted only when that list is the one selected.
 * - A paper already confirmed for one of our authors (either campus) is not
 *   counted as not yet attributed, whatever else is pending on it.
 *
 * SENSITIVE: per-person screening results. Only the gated page and its gated
 * export import this module. Nothing here logs a row.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import {
  CONSORTIUM_AUTHORS,
  LIST_COUNTRY,
  listCodesFor,
  type CampusFilter,
  type ResearchSecurityFilters,
} from "@/lib/edit/research-security-dashboard";

export type ResearchSecurityClient = Pick<
  PrismaClient,
  | "researchSecurityArticle"
  | "researchSecurityPerson"
  | "researchSecurityMatch"
  | "researchSecurityFundingFlag"
>;

/** The two campuses a count can be split by. A person row's `campus` can also
 *  be 'unknown' (a review-queue row with no proposed person). */
export type Campus = "wcm" | "ithaca";
export type Attribution = "confirmed" | "pending" | "review_queue";

export type ArticleFact = {
  articleId: string;
  pmid: number | null;
  title: string | null;
  journal: string | null;
  publicationDate: Date | null;
  publicationType: string | null;
  totalAuthors: number;
  doi: string | null;
  source: string;
};
export type PersonFact = {
  articleId: string;
  cwid: string | null;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  campus: string;
  department: string | null;
  title: string | null;
  attribution: string;
  /** An open review-queue row names this person on this paper (also true for
   *  a 'pending' row that has one). */
  inReviewQueue: boolean;
  reciterScore: number | null;
};
export type MatchFact = {
  articleId: string;
  listCode: string;
  category: string;
  listNo: number | null;
  entity: string;
  /** The matched co-author's position in the byline: the author's identity
   *  within a paper (two co-authors can share a name). */
  authorRank: number;
  authorName: string | null;
  /** reciterdb's bit: the name is that of SOME person of ours in scope on the
   *  paper, confirmed or not, either campus. Never counted on its own. */
  isInstitutionAuthor: boolean;
  /** WHICH of the paper's people the name is: cwids, comma-separated. */
  ourAuthorCwids: string | null;
};
export type FlagFact = {
  articleId: string;
  program: string;
  agency: string | null;
  grantId: string | null;
};

export type ResearchSecurityFacts = {
  articles: Map<string, ArticleFact>;
  /** Both campuses: whether a paper is already confirmed is a both-campus fact. */
  people: PersonFact[];
  /** Only the selected list(s) and category. */
  matches: MatchFact[];
  flags: FlagFact[];
  /** When the nightly copy was last replaced; null before the first load. */
  dataAsOf: Date | null;
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function articleWhere(f: ResearchSecurityFilters) {
  return {
    publicationDate: {
      gte: new Date(`${f.dateFrom}T00:00:00Z`),
      ...(f.dateTo ? { lte: new Date(`${f.dateTo}T00:00:00Z`) } : {}),
    },
    ...(f.excludeConsortia ? { totalAuthors: { lt: CONSORTIUM_AUTHORS } } : {}),
  };
}

function matchWhere(f: ResearchSecurityFilters) {
  return {
    listCode: { in: listCodesFor(f.list) },
    ...(f.category ? { category: f.category } : {}),
  };
}

/** The facts every view is derived from, narrowed by list, category, date
 *  range and consortium size. A paper with no publication date is outside
 *  every date range. The campus filter is applied by the pure functions. */
export async function loadResearchSecurityFacts(
  client: ResearchSecurityClient,
  f: ResearchSecurityFilters,
): Promise<ResearchSecurityFacts> {
  const article = articleWhere(f);
  const inScope = {
    ...article,
    OR: [{ matches: { some: matchWhere(f) } }, { fundingFlags: { some: {} } }],
  };
  const [articles, people, matches, flags, asOf] = await Promise.all([
    client.researchSecurityArticle.findMany({
      where: inScope,
      select: {
        articleId: true,
        pmid: true,
        title: true,
        journal: true,
        publicationDate: true,
        publicationType: true,
        totalAuthors: true,
        doi: true,
        source: true,
      },
    }),
    client.researchSecurityPerson.findMany({
      where: { article: inScope },
      select: {
        articleId: true,
        cwid: true,
        displayName: true,
        firstName: true,
        lastName: true,
        campus: true,
        department: true,
        title: true,
        attribution: true,
        inReviewQueue: true,
        reciterScore: true,
      },
      // A fixed input order, so every sort below is the same on every request.
      orderBy: { id: "asc" },
    }),
    // No affiliation text here: it is loaded for one page of papers at a time.
    client.researchSecurityMatch.findMany({
      where: { ...matchWhere(f), article },
      select: {
        articleId: true,
        listCode: true,
        category: true,
        listNo: true,
        entity: true,
        authorRank: true,
        authorName: true,
        isInstitutionAuthor: true,
        ourAuthorCwids: true,
      },
      orderBy: { id: "asc" },
    }),
    client.researchSecurityFundingFlag.findMany({
      where: { article },
      select: { articleId: true, program: true, agency: true, grantId: true },
    }),
    client.researchSecurityArticle.aggregate({ _max: { lastRefreshedAt: true } }),
  ]);
  return {
    articles: new Map(articles.map((a) => [a.articleId, a])),
    people,
    matches,
    flags,
    dataAsOf: asOf._max.lastRefreshedAt ?? null,
  };
}

/** The categories the category filter offers for a list choice. */
export async function loadCategories(
  client: ResearchSecurityClient,
  f: ResearchSecurityFilters,
): Promise<string[]> {
  const rows = await client.researchSecurityMatch.findMany({
    where: { listCode: { in: listCodesFor(f.list) } },
    distinct: ["category"],
    select: { category: true },
    orderBy: { category: "asc" },
  });
  return rows.map((r) => r.category);
}

export type MatchedString = {
  articleId: string;
  listCode: string;
  category: string;
  listNo: number | null;
  entity: string;
  authorName: string | null;
  affiliation: string | null;
  isInstitutionAuthor: boolean;
  ourAuthorCwids: string | null;
};

/** The exact matched co-author and affiliation strings for some papers. */
export async function loadMatchedStrings(
  client: ResearchSecurityClient,
  articleIds: string[],
  f: ResearchSecurityFilters,
): Promise<MatchedString[]> {
  if (articleIds.length === 0) return [];
  return client.researchSecurityMatch.findMany({
    where: { ...matchWhere(f), articleId: { in: articleIds } },
    select: {
      articleId: true,
      listCode: true,
      category: true,
      listNo: true,
      entity: true,
      authorName: true,
      affiliation: true,
      isInstitutionAuthor: true,
      ourAuthorCwids: true,
    },
    orderBy: [{ articleId: "asc" }, { entity: "asc" }, { authorRank: "asc" }, { id: "asc" }],
  });
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

export function isConsortium(totalAuthors: number): boolean {
  return totalAuthors >= CONSORTIUM_AUTHORS;
}

function inCampus(p: PersonFact, campus: CampusFilter): boolean {
  return campus === "both" || p.campus === campus;
}

function cwidsOf(m: { ourAuthorCwids: string | null }): string[] {
  return m.ourAuthorCwids ? m.ourAuthorCwids.toLowerCase().split(",") : [];
}

/**
 * Whether the matched co-author has the name of one of THESE people. Decided
 * once, by the ETL, with reciterdb's own name rule and both of a person's
 * names (`ourAuthorCwids`); nothing here compares names again. A person with
 * no cwid is never the one: reciterdb sets its bit for people with an id only.
 */
export function listedBy(m: { ourAuthorCwids: string | null }, people: readonly Pick<PersonFact, "cwid">[]): boolean {
  const cwids = cwidsOf(m);
  return cwids.length > 0 && people.some((p) => p.cwid != null && cwids.includes(p.cwid.toLowerCase()));
}

/** The candidate is the co-author who lists the entity (often a namesake). */
export function candidateListsEntity(p: Pick<PersonFact, "cwid">, articleMatches: readonly MatchFact[]): boolean {
  return articleMatches.some((m) => listedBy(m, [p]));
}

/**
 * Review priority of a not-yet-attributed row, as in the Section 1286 workbook:
 * 4 = 50+ author consortium; 1 = the candidate also lists the entity (often a
 * namesake, so a wrong suggestion: verify); 2 = likely ours (ReCiter score of
 * 90 or more, or an open review-queue row); 3 = everything else.
 */
export function unattributedPriority(r: {
  totalAuthors: number;
  candidateListsEntity: boolean;
  attribution: string;
  /** A pending suggestion can ALSO have an open review-queue row. */
  inReviewQueue?: boolean;
  reciterScore: number | null;
}): 1 | 2 | 3 | 4 {
  if (isConsortium(r.totalAuthors)) return 4;
  if (r.candidateListsEntity) return 1;
  if (r.inReviewQueue || r.attribution === "review_queue" || (r.reciterScore ?? 0) >= 90) return 2;
  return 3;
}

function group<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const g = m.get(k);
    if (g) g.push(r);
    else m.set(k, [r]);
  }
  return m;
}

type Index = {
  /** Confirmed people on each article, in the campus filter. */
  confirmed: Map<string, PersonFact[]>;
  /** Confirmed people on each article, both campuses. */
  confirmedAny: Map<string, PersonFact[]>;
  /** Pending and review-queue people on each article, in the campus filter. */
  unattributed: Map<string, PersonFact[]>;
  matches: Map<string, MatchFact[]>;
};

function indexFacts(facts: ResearchSecurityFacts, campus: CampusFilter): Index {
  const known = facts.people.filter((p) => facts.articles.has(p.articleId));
  const confirmedAny = known.filter((p) => p.attribution === "confirmed");
  return {
    confirmed: group(
      confirmedAny.filter((p) => inCampus(p, campus)),
      (p) => p.articleId,
    ),
    confirmedAny: group(confirmedAny, (p) => p.articleId),
    unattributed: group(
      known.filter((p) => p.attribution !== "confirmed" && inCampus(p, campus)),
      (p) => p.articleId,
    ),
    matches: group(
      facts.matches.filter((m) => facts.articles.has(m.articleId)),
      (m) => m.articleId,
    ),
  };
}

function personKey(p: PersonFact): string {
  return p.cwid ?? `?${p.displayName}`;
}

function uniqSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function byDateDesc(a: ArticleFact, b: ArticleFact): number {
  return (
    (b.publicationDate?.getTime() ?? 0) - (a.publicationDate?.getTime() ?? 0) ||
    a.articleId.localeCompare(b.articleId)
  );
}

function label(p: PersonFact): string {
  return p.cwid ? `${p.displayName} (${p.cwid})` : p.displayName;
}

// ----- Not yet attributed ---------------------------------------------------

export type UnattributedRow = {
  priority: 1 | 2 | 3 | 4;
  /** Another of our authors is already confirmed on this paper, so it is in
   *  the confirmed views and NOT in any not-yet-attributed count. */
  alreadyConfirmed: boolean;
  person: PersonFact;
  article: ArticleFact;
  entities: string[];
  categories: string[];
  candidateListsEntity: boolean;
};

/** One row per pending or review-queue candidate on a paper with a match in
 *  the selected list. Sorted by priority, then score, then date. */
export function buildUnattributedRows(
  facts: ResearchSecurityFacts,
  campus: CampusFilter,
): UnattributedRow[] {
  const ix = indexFacts(facts, campus);
  const rows: UnattributedRow[] = [];
  for (const [articleId, people] of ix.unattributed) {
    const matches = ix.matches.get(articleId);
    if (!matches) continue;
    const article = facts.articles.get(articleId)!;
    for (const person of people) {
      const lists = candidateListsEntity(person, matches);
      rows.push({
        priority: unattributedPriority({
          totalAuthors: article.totalAuthors,
          candidateListsEntity: lists,
          attribution: person.attribution,
          inReviewQueue: person.inReviewQueue,
          reciterScore: person.reciterScore,
        }),
        alreadyConfirmed: ix.confirmedAny.has(articleId),
        person,
        article,
        entities: uniqSorted(matches.map((m) => m.entity)),
        categories: uniqSorted(matches.map((m) => m.category)),
        candidateListsEntity: lists,
      });
    }
  }
  return rows.sort(
    (a, b) =>
      a.priority - b.priority ||
      (b.person.reciterScore ?? -1) - (a.person.reciterScore ?? -1) ||
      byDateDesc(a.article, b.article) ||
      personKey(a.person).localeCompare(personKey(b.person)),
  );
}

/** Distinct papers that are not yet attributed: a row for a paper someone is
 *  already confirmed on does not count. */
export function countUnattributedPapers(rows: readonly UnattributedRow[]): number {
  return new Set(rows.filter((r) => !r.alreadyConfirmed).map((r) => r.article.articleId)).size;
}

// ----- By entity -------------------------------------------------------------

export type EntityRow = {
  listCode: string;
  category: string;
  listNo: number | null;
  entity: string;
  /** Confirmed co-publications. */
  papers: number;
  papersWcm: number;
  papersIthaca: number;
  papersExcludingConsortia: number;
  /** Distinct confirmed people of ours. */
  people: number;
  /** Confirmed papers where the co-author at THIS entity has the name of one of
   *  the paper's confirmed authors in the campus filter. A pending or
   *  review-queue namesake, or one on the other campus, does not count. */
  papersOurAuthorListsEntity: number;
  unattributedPapers: number;
  unattributedPriority12: number;
};

export function buildEntityRows(facts: ResearchSecurityFacts, campus: CampusFilter): EntityRow[] {
  const ix = indexFacts(facts, campus);
  const unattributed = buildUnattributedRows(facts, campus).filter((r) => !r.alreadyConfirmed);
  const bestPriority = new Map<string, number>();
  for (const r of unattributed) {
    const id = r.article.articleId;
    bestPriority.set(id, Math.min(bestPriority.get(id) ?? 4, r.priority));
  }

  const rows: EntityRow[] = [];
  for (const matches of group(facts.matches, (m) => `${m.listCode}\u0000${m.entity}`).values()) {
    const head = matches[0];
    const articleIds = [...new Set(matches.map((m) => m.articleId))];
    const confirmedIds = articleIds.filter((id) => ix.confirmed.has(id));
    const openIds = articleIds.filter((id) => bestPriority.has(id));
    if (confirmedIds.length === 0 && openIds.length === 0) continue;
    const people = new Set<string>();
    for (const id of confirmedIds) for (const p of ix.confirmed.get(id)!) people.add(personKey(p));
    const listed = new Set(
      matches
        .filter((m) => listedBy(m, ix.confirmed.get(m.articleId) ?? []))
        .map((m) => m.articleId),
    );
    const has = (id: string, c: Campus) => ix.confirmed.get(id)!.some((p) => p.campus === c);
    rows.push({
      listCode: head.listCode,
      category: head.category,
      listNo: head.listNo,
      entity: head.entity,
      papers: confirmedIds.length,
      papersWcm: confirmedIds.filter((id) => has(id, "wcm")).length,
      papersIthaca: confirmedIds.filter((id) => has(id, "ithaca")).length,
      papersExcludingConsortia: confirmedIds.filter(
        (id) => !isConsortium(facts.articles.get(id)!.totalAuthors),
      ).length,
      people: people.size,
      papersOurAuthorListsEntity: confirmedIds.filter((id) => listed.has(id)).length,
      unattributedPapers: openIds.length,
      unattributedPriority12: openIds.filter((id) => bestPriority.get(id)! <= 2).length,
    });
  }
  return rows.sort(
    (a, b) =>
      b.papers - a.papers ||
      b.unattributedPapers - a.unattributedPapers ||
      a.entity.localeCompare(b.entity) ||
      a.listCode.localeCompare(b.listCode),
  );
}

// ----- By person -------------------------------------------------------------

export type PersonRow = {
  cwid: string | null;
  name: string;
  campus: string;
  department: string | null;
  title: string | null;
  /** Confirmed co-publications. */
  papers: number;
  papersExcludingConsortia: number;
  entities: string[];
};

export function buildPersonRows(facts: ResearchSecurityFacts, campus: CampusFilter): PersonRow[] {
  const ix = indexFacts(facts, campus);
  const byPerson = new Map<string, { person: PersonFact; articleIds: Set<string> }>();
  for (const [articleId, people] of ix.confirmed) {
    if (!ix.matches.has(articleId)) continue;
    for (const p of people) {
      const k = personKey(p);
      const entry = byPerson.get(k) ?? { person: p, articleIds: new Set<string>() };
      entry.articleIds.add(articleId);
      byPerson.set(k, entry);
    }
  }
  return [...byPerson.values()]
    .map(({ person, articleIds }) => ({
      cwid: person.cwid,
      name: person.displayName,
      campus: person.campus,
      department: person.department,
      title: person.title,
      papers: articleIds.size,
      papersExcludingConsortia: [...articleIds].filter(
        (id) => !isConsortium(facts.articles.get(id)!.totalAuthors),
      ).length,
      entities: uniqSorted([...articleIds].flatMap((id) => ix.matches.get(id)!.map((m) => m.entity))),
    }))
    .sort(
      (a, b) =>
        b.papers - a.papers ||
        a.name.localeCompare(b.name) ||
        (a.cwid ?? "").localeCompare(b.cwid ?? ""),
    );
}

// ----- By paper --------------------------------------------------------------

export type PaperRow = {
  article: ArticleFact;
  /** Confirmed authors, labelled "Name (cwid)". */
  wcmAuthors: string[];
  ithacaAuthors: string[];
  entities: string[];
  categories: string[];
  /** Distinct co-authors (byline positions) at a listed entity. */
  coAuthorsAtEntities: number;
  /** A co-author at a listed entity has the name of one of this paper's
   *  CONFIRMED authors in the campus filter. */
  ourAuthorListsEntity: boolean;
  fundingPrograms: string[];
  consortium: boolean;
};

function authorsOf(people: readonly PersonFact[], campus: Campus): string[] {
  return uniqSorted(people.filter((p) => p.campus === campus).map(label));
}

/** Confirmed co-publications: a match in the selected list and a confirmed
 *  author in the campus filter. Authors of both campuses are listed. */
export function buildPaperRows(facts: ResearchSecurityFacts, campus: CampusFilter): PaperRow[] {
  const ix = indexFacts(facts, campus);
  const flags = group(facts.flags, (f) => f.articleId);
  const rows: PaperRow[] = [];
  for (const [articleId, matches] of ix.matches) {
    if (!ix.confirmed.has(articleId)) continue;
    const article = facts.articles.get(articleId)!;
    const people = ix.confirmedAny.get(articleId)!;
    rows.push({
      article,
      wcmAuthors: authorsOf(people, "wcm"),
      ithacaAuthors: authorsOf(people, "ithaca"),
      entities: uniqSorted(matches.map((m) => m.entity)),
      categories: uniqSorted(matches.map((m) => m.category)),
      coAuthorsAtEntities: new Set(matches.map((m) => m.authorRank)).size,
      ourAuthorListsEntity: matches.some((m) => listedBy(m, ix.confirmed.get(articleId)!)),
      fundingPrograms: uniqSorted((flags.get(articleId) ?? []).map((f) => f.program)),
      consortium: isConsortium(article.totalAuthors),
    });
  }
  return rows.sort((a, b) => byDateDesc(a.article, b.article));
}

// ----- Funding flags ---------------------------------------------------------

export type FundingRow = {
  article: ArticleFact;
  program: string;
  agency: string | null;
  grantId: string | null;
  wcmAuthors: string[];
  ithacaAuthors: string[];
};

/** Funding flags on papers with a confirmed author in the campus filter. The
 *  list and category filters do not apply: a flag is not a list match. */
export function buildFundingRows(facts: ResearchSecurityFacts, campus: CampusFilter): FundingRow[] {
  const ix = indexFacts(facts, campus);
  return facts.flags
    .filter((f) => ix.confirmed.has(f.articleId))
    .map((f) => {
      const people = ix.confirmedAny.get(f.articleId)!;
      return {
        article: facts.articles.get(f.articleId)!,
        program: f.program,
        agency: f.agency,
        grantId: f.grantId,
        wcmAuthors: authorsOf(people, "wcm"),
        ithacaAuthors: authorsOf(people, "ithaca"),
      };
    })
    .sort((a, b) => byDateDesc(a.article, b.article) || a.program.localeCompare(b.program));
}

// ----- Headline --------------------------------------------------------------

export type ResearchSecuritySummary = {
  /** Which tier the list filter selected. The two are never added together. */
  tier: "entity" | "country";
  /** Confirmed co-publications in the selected list(s). */
  coPublications: number;
  coPublicationsExcludingConsortia: number;
  /** Distinct confirmed people of ours on those papers. */
  people: number;
  /** Distinct entities (or countries) with a confirmed co-publication. */
  entities: number;
  /** Papers with a funding flag and a confirmed author. */
  fundingFlagPapers: number;
  /** Papers with a match whose authorship is not yet confirmed for anyone. */
  unattributedPapers: number;
};

export function buildSummary(
  facts: ResearchSecurityFacts,
  f: Pick<ResearchSecurityFilters, "campus" | "list">,
): ResearchSecuritySummary {
  const papers = buildPaperRows(facts, f.campus);
  return {
    tier: f.list === LIST_COUNTRY ? "country" : "entity",
    coPublications: papers.length,
    coPublicationsExcludingConsortia: papers.filter((p) => !p.consortium).length,
    people: buildPersonRows(facts, f.campus).length,
    entities: buildEntityRows(facts, f.campus).filter((e) => e.papers > 0).length,
    fundingFlagPapers: new Set(buildFundingRows(facts, f.campus).map((r) => r.article.articleId)).size,
    unattributedPapers: countUnattributedPapers(buildUnattributedRows(facts, f.campus)),
  };
}

// ---------------------------------------------------------------------------
// Display helpers shared by the page and the export
// ---------------------------------------------------------------------------

export function articleLink(a: Pick<ArticleFact, "pmid" | "doi">): string | null {
  if (a.pmid) return `https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`;
  return a.doi ? `https://doi.org/${a.doi}` : null;
}

export function isoDay(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

export const ATTRIBUTION_REASON: Record<string, string> = {
  pending: "ReCiter suggestion, not yet reviewed",
  review_queue: "Open authorship-review queue row",
};

/** Why a row is not yet attributed. A suggestion that also has an open
 *  review-queue row says so: that is what makes it priority 2. */
export function attributionReason(p: Pick<PersonFact, "attribution" | "inReviewQueue">): string {
  if (p.attribution === "pending" && p.inReviewQueue)
    return "ReCiter suggestion, also in the authorship-review queue";
  return ATTRIBUTION_REASON[p.attribution] ?? p.attribution;
}

/**
 * The matched strings of the By paper view, with `isInstitutionAuthor`
 * narrowed from reciterdb's "some person of ours in scope" to "a confirmed
 * author of this paper in the campus filter", the same rule as the paper
 * row's own flag, so the two never disagree.
 */
export function forConfirmedAuthors(
  strings: readonly MatchedString[],
  facts: ResearchSecurityFacts,
  campus: CampusFilter,
): MatchedString[] {
  const ix = indexFacts(facts, campus);
  return strings.map((m) => ({
    ...m,
    isInstitutionAuthor: listedBy(m, ix.confirmed.get(m.articleId) ?? []),
  }));
}

export function paginate<T>(rows: readonly T[], page: number, size: number) {
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), totalPages);
  return { rows: rows.slice((current - 1) * size, current * size), page: current, totalPages, total: rows.length };
}
