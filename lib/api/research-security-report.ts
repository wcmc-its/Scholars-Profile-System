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
  defaultSortDir,
  type CampusFilter,
  type ResearchSecurityArrange,
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
  /** The person filter (a cwid): every view keeps only this person's papers.
   *  Applied by `indexFacts`, so the rules below hold under it unchanged. */
  person?: string;
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
    ...(f.entity ? { entity: f.entity } : {}),
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
    person: f.person,
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

/** The entities (countries, in the country tier) the entity filter offers for
 *  a list and category choice. */
export async function loadEntities(
  client: ResearchSecurityClient,
  f: ResearchSecurityFilters,
): Promise<string[]> {
  const rows = await client.researchSecurityMatch.findMany({
    where: {
      listCode: { in: listCodesFor(f.list) },
      ...(f.category ? { category: f.category } : {}),
    },
    distinct: ["entity"],
    select: { entity: true },
    orderBy: { entity: "asc" },
  });
  return rows.map((r) => r.entity);
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

function isPerson(p: Pick<PersonFact, "cwid">, cwid: string): boolean {
  return p.cwid != null && p.cwid.toLowerCase() === cwid.toLowerCase();
}

function indexFacts(facts: ResearchSecurityFacts, campus: CampusFilter): Index {
  const known = facts.people.filter((p) => facts.articles.has(p.articleId));
  const confirmedAny = known.filter((p) => p.attribution === "confirmed");
  const who = facts.person;
  // Under a person filter a paper is confirmed only when THAT person is a
  // confirmed author of it in the campus filter (all of the paper's confirmed
  // authors stay listed), and only that person's own open rows are kept.
  // `confirmedAny` is not narrowed: whether a paper is already confirmed for
  // someone is the same fact with or without the filter.
  const confirmed = group(
    confirmedAny.filter((p) => inCampus(p, campus)),
    (p) => p.articleId,
  );
  if (who) {
    for (const [id, people] of confirmed) {
      if (!people.some((p) => isPerson(p, who))) confirmed.delete(id);
    }
  }
  return {
    confirmed,
    confirmedAny: group(confirmedAny, (p) => p.articleId),
    unattributed: group(
      known.filter(
        (p) => p.attribution !== "confirmed" && inCampus(p, campus) && (!who || isPerson(p, who)),
      ),
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
      // Under a person filter this view is that person's row alone.
      if (facts.person && !isPerson(p, facts.person)) continue;
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
// Not yet attributed, one row per candidate
// ---------------------------------------------------------------------------

export type UnattributedGroup = {
  key: string;
  person: PersonFact;
  /** The candidate's open rows, in the order of `buildUnattributedRows`. */
  rows: UnattributedRow[];
  /** Distinct papers that count as not yet attributed (not already confirmed). */
  papers: number;
  /** The best (lowest) priority among the rows. */
  priority: 1 | 2 | 3 | 4;
  maxScore: number | null;
  entities: string[];
  candidateListsEntity: boolean;
};

/**
 * The not-yet-attributed rows grouped by candidate, so one person with forty
 * suggestions is one row. A row with no proposed person (no cwid) is never
 * merged with another: it stays a group of its own. Groups keep the order of
 * their first row, so the default order is still priority, then score.
 */
export function groupUnattributedRows(rows: readonly UnattributedRow[]): UnattributedGroup[] {
  const groups = group(rows, (r) =>
    r.person.cwid ? r.person.cwid.toLowerCase() : `?${r.article.articleId}|${r.person.displayName}`,
  );
  return [...groups].map(([key, mine]) => {
    const scores = mine.map((r) => r.person.reciterScore).filter((x): x is number => x != null);
    return {
      key,
      person: mine[0].person,
      rows: mine,
      papers: countUnattributedPapers(mine),
      priority: Math.min(...mine.map((r) => r.priority)) as 1 | 2 | 3 | 4,
      maxScore: scores.length > 0 ? Math.max(...scores) : null,
      entities: uniqSorted(mine.flatMap((r) => r.entities)),
      candidateListsEntity: mine.some((r) => r.candidateListsEntity),
    };
  });
}

// ---------------------------------------------------------------------------
// One person: everything this screen holds about them
// ---------------------------------------------------------------------------

export type PersonProfile = {
  cwid: string;
  name: string;
  campus: string;
  department: string | null;
  title: string | null;
  /** Confirmed co-publications under the filters. */
  confirmedPapers: number;
  confirmedExcludingConsortia: number;
  /** Publication years of the confirmed co-publications. */
  firstYear: number | null;
  lastYear: number | null;
  /** Confirmed papers where the co-author at a listed entity has THIS person's name. */
  listsEntityPapers: number;
  /** Papers suggested for this person that nobody is confirmed on yet. */
  openPapers: number;
  /** Open rows on papers already confirmed for another author (not counted). */
  openAlreadyConfirmed: number;
  openInReviewQueue: number;
  openListsEntity: number;
  scoreMin: number | null;
  scoreMax: number | null;
  fundingFlagPapers: number;
  entities: Array<{ entity: string; confirmed: number; open: number }>;
  /** Our other confirmed authors on this person's confirmed co-publications. */
  coAuthors: Array<{ cwid: string | null; name: string; papers: number }>;
  /** The confirmed co-publications (newest first), for lookups about them. */
  confirmedArticleIds: string[];
};

/** The person of the person filter, summarized under the other filters; null
 *  when there is no person filter or the person is on no paper in scope. */
export function buildPersonProfile(
  facts: ResearchSecurityFacts,
  campus: CampusFilter,
): PersonProfile | null {
  const who = facts.person;
  if (!who) return null;
  const mine = facts.people.filter((p) => isPerson(p, who) && facts.articles.has(p.articleId));
  const identity = mine.find((p) => p.attribution === "confirmed") ?? mine[0];
  if (!identity) return null;
  const ix = indexFacts(facts, campus);
  const confirmedIds = [...ix.confirmed.keys()].filter((id) => ix.matches.has(id));
  const open = buildUnattributedRows(facts, campus);
  const counted = open.filter((r) => !r.alreadyConfirmed);
  const years = confirmedIds
    .map((id) => facts.articles.get(id)!.publicationDate?.getUTCFullYear())
    .filter((y): y is number => y != null);
  const scores = open.map((r) => r.person.reciterScore).filter((x): x is number => x != null);

  const entities = new Map<string, { entity: string; confirmed: number; open: number }>();
  const tally = (entity: string, k: "confirmed" | "open") => {
    const e = entities.get(entity) ?? { entity, confirmed: 0, open: 0 };
    e[k] += 1;
    entities.set(entity, e);
  };
  for (const id of confirmedIds) {
    for (const e of new Set(ix.matches.get(id)!.map((m) => m.entity))) tally(e, "confirmed");
  }
  for (const id of new Set(counted.map((r) => r.article.articleId))) {
    for (const e of new Set(ix.matches.get(id)!.map((m) => m.entity))) tally(e, "open");
  }

  const coAuthors = new Map<string, { cwid: string | null; name: string; papers: number }>();
  for (const id of confirmedIds) {
    const others = (ix.confirmedAny.get(id) ?? []).filter((p) => !isPerson(p, who));
    for (const [k, [p]] of group(others, personKey)) {
      const c = coAuthors.get(k) ?? { cwid: p.cwid, name: p.displayName, papers: 0 };
      c.papers += 1;
      coAuthors.set(k, c);
    }
  }

  return {
    cwid: identity.cwid!,
    name: identity.displayName,
    campus: identity.campus,
    department: identity.department,
    title: identity.title,
    confirmedPapers: confirmedIds.length,
    confirmedExcludingConsortia: confirmedIds.filter(
      (id) => !isConsortium(facts.articles.get(id)!.totalAuthors),
    ).length,
    firstYear: years.length > 0 ? Math.min(...years) : null,
    lastYear: years.length > 0 ? Math.max(...years) : null,
    listsEntityPapers: confirmedIds.filter((id) =>
      ix.matches.get(id)!.some((m) => listedBy(m, [identity])),
    ).length,
    openPapers: countUnattributedPapers(open),
    openAlreadyConfirmed: open.length - counted.length,
    openInReviewQueue: counted.filter((r) => r.person.inReviewQueue).length,
    openListsEntity: counted.filter((r) => r.candidateListsEntity).length,
    scoreMin: scores.length > 0 ? Math.min(...scores) : null,
    scoreMax: scores.length > 0 ? Math.max(...scores) : null,
    fundingFlagPapers: new Set(buildFundingRows(facts, campus).map((r) => r.article.articleId)).size,
    entities: [...entities.values()].sort(
      (a, b) => b.confirmed + b.open - (a.confirmed + a.open) || a.entity.localeCompare(b.entity),
    ),
    coAuthors: [...coAuthors.values()].sort(
      (a, b) => b.papers - a.papers || a.name.localeCompare(b.name),
    ),
    confirmedArticleIds: [...confirmedIds].sort((a, b) =>
      byDateDesc(facts.articles.get(a)!, facts.articles.get(b)!),
    ),
  };
}

// ---------------------------------------------------------------------------
// One entity (or country): everything this screen holds about it
// ---------------------------------------------------------------------------

export type EntityProfile = {
  entity: string;
  /** The list(s) it is on, with the category and number each gives it. */
  listings: Array<{ listCode: string; category: string; listNo: number | null }>;
  /** Confirmed co-publications under the filters. */
  confirmedPapers: number;
  papersWcm: number;
  papersIthaca: number;
  confirmedExcludingConsortia: number;
  /** Distinct confirmed people of ours. */
  people: number;
  papersOurAuthorListsEntity: number;
  /** Papers with a match here that nobody is confirmed on yet. */
  unattributedPapers: number;
  /** Confirmed co-publications that also carry a funding flag. */
  fundingFlagPapers: number;
  /** Confirmed co-publications per publication year, every year in the span. */
  byYear: Array<{ year: number; papers: number }>;
  topPeople: Array<{
    cwid: string | null;
    name: string;
    campus: string;
    department: string | null;
    papers: number;
  }>;
  departments: Array<{ department: string; campus: string; papers: number }>;
  /**
   * Co-authors at the entity on two or more confirmed papers, by the name in
   * the byline. APPROXIMATE: two people can share a name, and one person can
   * be spelled two ways. `ourName` = the name is one of our confirmed authors'.
   */
  coAuthors: Array<{ name: string; papers: number; ourName: boolean }>;
  /** The articles the affiliation strings are read for (confirmed, newest first). */
  confirmedArticleIds: string[];
};

const PROFILE_PEOPLE = 10;
const PROFILE_DEPARTMENTS = 8;
const PROFILE_COAUTHORS = 10;

/** The entity of the entity filter, summarized under the other filters; null
 *  when it has no match in scope. `facts.matches` may hold other entities
 *  (a caller without the SQL filter): only this entity's are read. */
export function buildEntityProfile(
  facts: ResearchSecurityFacts,
  campus: CampusFilter,
  entity: string | undefined,
): EntityProfile | null {
  if (!entity) return null;
  const mine = facts.matches.filter((m) => m.entity === entity && facts.articles.has(m.articleId));
  if (mine.length === 0) return null;
  const ix = indexFacts(facts, campus);
  const byArticle = group(mine, (m) => m.articleId);
  const confirmedIds = [...byArticle.keys()]
    .filter((id) => ix.confirmed.has(id))
    .sort((a, b) => byDateDesc(facts.articles.get(a)!, facts.articles.get(b)!));
  const open = new Set(
    buildUnattributedRows(facts, campus)
      .filter((r) => !r.alreadyConfirmed && byArticle.has(r.article.articleId))
      .map((r) => r.article.articleId),
  );
  const flagged = new Set(facts.flags.map((f) => f.articleId));
  const has = (id: string, c: Campus) => ix.confirmed.get(id)!.some((p) => p.campus === c);

  const years = new Map<number, number>();
  for (const id of confirmedIds) {
    const y = facts.articles.get(id)!.publicationDate?.getUTCFullYear();
    if (y != null) years.set(y, (years.get(y) ?? 0) + 1);
  }
  const span = [...years.keys()];
  const byYear =
    span.length === 0
      ? []
      : Array.from({ length: Math.max(...span) - Math.min(...span) + 1 }, (_, i) => {
          const year = Math.min(...span) + i;
          return { year, papers: years.get(year) ?? 0 };
        });

  const people = new Map<string, EntityProfile["topPeople"][number]>();
  const departments = new Map<string, EntityProfile["departments"][number]>();
  const coAuthors = new Map<string, { name: string; ids: Set<string>; ourName: boolean }>();
  for (const id of confirmedIds) {
    const ours = ix.confirmed.get(id)!;
    for (const [k, [p]] of group(ours, personKey)) {
      const e = people.get(k) ?? {
        cwid: p.cwid,
        name: p.displayName,
        campus: p.campus,
        department: p.department,
        papers: 0,
      };
      e.papers += 1;
      people.set(k, e);
    }
    // A paper counts once per department, however many of its people are on it.
    for (const [k, [p]] of group(
      ours.filter((p) => p.department),
      (p) => `${p.campus}\u0000${p.department}`,
    )) {
      const d = departments.get(k) ?? { department: p.department!, campus: p.campus, papers: 0 };
      d.papers += 1;
      departments.set(k, d);
    }
    for (const m of byArticle.get(id)!) {
      const name = m.authorName?.trim();
      if (!name) continue;
      const k = name.toLowerCase();
      const c = coAuthors.get(k) ?? { name, ids: new Set<string>(), ourName: false };
      c.ids.add(id);
      c.ourName ||= listedBy(m, ours);
      coAuthors.set(k, c);
    }
  }
  const top = <T extends { papers: number }>(rows: T[], label: (r: T) => string, n: number) =>
    rows.sort((a, b) => b.papers - a.papers || label(a).localeCompare(label(b))).slice(0, n);

  return {
    entity,
    listings: [...group(mine, (m) => `${m.listCode}\u0000${m.category}`).values()]
      .map(([m]) => ({ listCode: m.listCode, category: m.category, listNo: m.listNo }))
      .sort((a, b) => a.listCode.localeCompare(b.listCode) || a.category.localeCompare(b.category)),
    confirmedPapers: confirmedIds.length,
    papersWcm: confirmedIds.filter((id) => has(id, "wcm")).length,
    papersIthaca: confirmedIds.filter((id) => has(id, "ithaca")).length,
    confirmedExcludingConsortia: confirmedIds.filter(
      (id) => !isConsortium(facts.articles.get(id)!.totalAuthors),
    ).length,
    people: people.size,
    papersOurAuthorListsEntity: confirmedIds.filter((id) =>
      byArticle.get(id)!.some((m) => listedBy(m, ix.confirmed.get(id)!)),
    ).length,
    unattributedPapers: open.size,
    fundingFlagPapers: confirmedIds.filter((id) => flagged.has(id)).length,
    byYear,
    topPeople: top([...people.values()], (p) => p.name, PROFILE_PEOPLE),
    departments: top([...departments.values()], (d) => d.department, PROFILE_DEPARTMENTS),
    coAuthors: top(
      [...coAuthors.values()]
        .map((c) => ({ name: c.name, papers: c.ids.size, ourName: c.ourName }))
        .filter((c) => c.papers >= 2),
      (c) => c.name,
      PROFILE_COAUTHORS,
    ),
    confirmedArticleIds: confirmedIds,
  };
}

/** The affiliation strings that recur most among an entity's matches: they
 *  show which sub-units (a hospital, a school, a lab) are involved. Strings
 *  are compared ignoring case and spacing; a paper counts once per string. */
export function topAffiliations(
  strings: readonly Pick<MatchedString, "articleId" | "entity" | "affiliation">[],
  entity: string,
  limit = 8,
): Array<{ affiliation: string; papers: number }> {
  const seen = new Map<string, { affiliation: string; ids: Set<string> }>();
  for (const m of strings) {
    const text = m.affiliation?.replace(/\s+/g, " ").trim();
    if (!text || m.entity !== entity) continue;
    const k = text.toLowerCase();
    const e = seen.get(k) ?? { affiliation: text, ids: new Set<string>() };
    e.ids.add(m.articleId);
    seen.set(k, e);
  }
  return [...seen.values()]
    .map((e) => ({ affiliation: e.affiliation, papers: e.ids.size }))
    .sort((a, b) => b.papers - a.papers || a.affiliation.localeCompare(b.affiliation))
    .slice(0, limit);
}

/**
 * A set of papers as the methods lookup needs it
 * (`lib/api/research-security-methods.ts`): their PMIDs, and our confirmed
 * authors on them (either campus: what a paper used is a fact about the paper),
 * most papers first. `onlyCwid` reads one person's rows alone.
 */
export function paperScope(
  facts: ResearchSecurityFacts,
  articleIds: readonly string[],
  onlyCwid?: string,
): { cwids: string[]; pmids: number[]; papers: number } {
  const ids = new Set(articleIds);
  const counts = new Map<string, number>();
  for (const p of facts.people) {
    if (p.attribution !== "confirmed" || !p.cwid || !ids.has(p.articleId)) continue;
    if (onlyCwid && !isPerson(p, onlyCwid)) continue;
    counts.set(p.cwid, (counts.get(p.cwid) ?? 0) + 1);
  }
  return {
    cwids: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([cwid]) => cwid),
    pmids: articleIds
      .map((id) => facts.articles.get(id)?.pmid)
      .filter((x): x is number => x != null),
    papers: articleIds.length,
  };
}

// ---------------------------------------------------------------------------
// Search and sort of one view's table
// ---------------------------------------------------------------------------

type Text = string | number | null | undefined;

/**
 * Applies `q` (every word must appear somewhere in the row's text) and the
 * sort. The input is in the view's default order and the sort is stable, so
 * ties keep that order; the default key in its default direction is a no-op.
 */
function arrange<T>(
  rows: readonly T[],
  a: ResearchSecurityArrange,
  defaultKey: string,
  text: (r: T) => Text[],
  values: Record<string, (r: T) => string | number | null>,
): T[] {
  const words = (a.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  let out =
    words.length === 0
      ? [...rows]
      : rows.filter((r) => {
          const hay = text(r).filter((t) => t != null).join("\n").toLowerCase();
          return words.every((w) => hay.includes(w));
        });
  const key = a.sort ?? defaultKey;
  const dir = a.dir ?? defaultSortDir(key);
  if (key === defaultKey) {
    if (dir !== defaultSortDir(key)) out = out.reverse();
    return out;
  }
  const value = values[key];
  if (!value) return out;
  const sign = dir === "asc" ? 1 : -1;
  return out.sort((x, y) => {
    const vx = value(x);
    const vy = value(y);
    // A missing value sorts last in either direction.
    if (vx == null || vy == null) return vx == null ? (vy == null ? 0 : 1) : -1;
    return (
      sign *
      (typeof vx === "number" && typeof vy === "number"
        ? vx - vy
        : String(vx).localeCompare(String(vy)))
    );
  });
}

const articleText = (a: ArticleFact): Text[] => [a.title, a.journal, a.pmid, a.articleId, a.doi];
const personText = (p: PersonFact): Text[] => [p.displayName, p.cwid, p.department];

export function arrangeEntityRows(rows: readonly EntityRow[], a: ResearchSecurityArrange): EntityRow[] {
  return arrange(rows, a, "papers", (r) => [r.entity, r.category], {
    entity: (r) => r.entity,
    people: (r) => r.people,
    unattributed: (r) => r.unattributedPapers,
  });
}

export function arrangePersonRows(rows: readonly PersonRow[], a: ResearchSecurityArrange): PersonRow[] {
  return arrange(rows, a, "papers", (r) => [r.name, r.cwid, r.department, r.title], {
    name: (r) => r.name,
    department: (r) => r.department,
  });
}

export function arrangePaperRows(rows: readonly PaperRow[], a: ResearchSecurityArrange): PaperRow[] {
  return arrange(
    rows,
    a,
    "date",
    (r) => [...articleText(r.article), ...r.wcmAuthors, ...r.ithacaAuthors, ...r.entities],
    { title: (r) => r.article.title, authors: (r) => r.article.totalAuthors },
  );
}

export function arrangeFundingRows(rows: readonly FundingRow[], a: ResearchSecurityArrange): FundingRow[] {
  return arrange(
    rows,
    a,
    "date",
    (r) => [...articleText(r.article), r.program, r.agency, r.grantId, ...r.wcmAuthors, ...r.ithacaAuthors],
    { program: (r) => r.program },
  );
}

/** Search only: the flat rows keep the order of `buildUnattributedRows`. */
export function searchUnattributedRows(
  rows: readonly UnattributedRow[],
  q: string | undefined,
): UnattributedRow[] {
  return arrange(rows, { q }, "priority", (r) => [
    ...personText(r.person),
    ...articleText(r.article),
    ...r.entities,
  ], {});
}

/** Sort only: search is applied to the rows before they are grouped. */
export function sortUnattributedGroups(
  groups: readonly UnattributedGroup[],
  a: ResearchSecurityArrange,
): UnattributedGroup[] {
  return arrange(groups, { sort: a.sort, dir: a.dir }, "priority", () => [], {
    papers: (g) => g.papers,
    score: (g) => g.maxScore,
    name: (g) => g.person.displayName,
  });
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
