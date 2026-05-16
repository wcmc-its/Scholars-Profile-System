/**
 * CSV export — server-side data fetcher (#89 Phase 1).
 *
 * Resolves the same `{q, filters, sort}` shape as `searchPublications`
 * into a flat row array suitable for CSV serialization. Two granularities:
 *   - "authorship" → one row per (WCM author, publication) pair
 *   - "article"    → one row per publication
 *
 * Pipeline:
 *   1. Hit OpenSearch with the search query, capped at MAX_LIMIT, asking
 *      only for `pmid` to keep the payload small. Sort honors the same
 *      contract as the results page (relevance / year / citations).
 *   2. Hydrate full publication + author + scholar rows from Prisma in
 *      one round trip; preserve OpenSearch order via a Map lookup.
 *   3. Project per granularity. Skip the metric columns Scholars doesn't
 *      currently carry (journalImpactScore, NIH iCite, Mendeley readers,
 *      etc.) — issue #89 spec §6.1 inherits these from PM but they live
 *      in reciterdb tables that haven't been backfilled into Scholars.
 *      Follow-up issue can plumb them through if needed.
 *
 * Rate limiting and configurable column visibility are deferred to
 * Phase 2; see issue #89 §11.
 */
import { prisma } from "@/lib/db";
import {
  PUBLICATION_FIELD_BOOSTS,
  PUBLICATIONS_INDEX,
  searchClient,
} from "@/lib/search";
import type { PublicationsFilters, PublicationsSort } from "@/lib/api/search";
import { htmlToPlainText } from "@/lib/utils";

/** Hardcoded ceiling for Phase 1; spec §7.1 hard cap is 30,000. */
export const EXPORT_MAX_LIMIT = 5000;

export type ExportGranularity = "authorship" | "article";

export type ExportRequest = {
  q: string;
  filters?: PublicationsFilters;
  sort?: PublicationsSort;
  /** Optional override; clamped to EXPORT_MAX_LIMIT regardless. */
  limit?: number;
};

export type AuthorshipRow = {
  personIdentifier: string;
  lastName: string;
  firstName: string;
  primaryDepartment: string | null;
  pmid: string;
  title: string;
  year: number | null;
  journal: string | null;
  doi: string | null;
  pmcid: string | null;
  dateAddedToEntrez: string | null;
  citationCount: number;
  publicationType: string | null;
  authors: string;
  authorPosition: string;
};

export type ArticleRow = {
  pmid: string;
  title: string;
  year: number | null;
  journal: string | null;
  doi: string | null;
  pmcid: string | null;
  dateAddedToEntrez: string | null;
  citationCount: number;
  publicationType: string | null;
  authors: string;
};

// Spec §6.2: strip these characters from the authors string + position
// label. Mirrors PM's existing transform — these characters trip up some
// downstream consumers that double-quote on word boundaries.
const STRIP_RE = /[\])}[{(]/g;

function stripBrackets(s: string | null): string {
  if (!s) return "";
  return s.replace(STRIP_RE, "");
}

/** PubMed titles carry inline HTML (`<i>BRCA1</i>`, `H<sub>2</sub>O`).
 *  CSV consumers expect plain text, so strip every tag before emitting
 *  the cell. `htmlToPlainText` also decodes the handful of HTML entities
 *  PubMed emits (`&amp;` → `&`). Truncation is disabled; a 500-char
 *  title is rare but legitimate. (#331) */
function plainTitleForCsv(title: string): string {
  return htmlToPlainText(title, Number.POSITIVE_INFINITY);
}

/**
 * Same display-name → ("first", "last") split as the AuthorFacet sort
 * key. Drops trailing postnominal segments (", MD") then takes the
 * final whitespace token as the last name; the rest is the first name.
 * Heuristic, not perfect for compound surnames — but this is a CSV
 * export, not a citation engine, and admins can post-process.
 */
function splitName(displayName: string): { first: string; last: string } {
  const noPostnom = displayName.split(/,\s*/)[0] ?? displayName;
  const tokens = noPostnom.trim().split(/\s+/);
  if (tokens.length <= 1) return { first: "", last: tokens[0] ?? "" };
  const last = tokens[tokens.length - 1] ?? "";
  const first = tokens.slice(0, -1).join(" ");
  return { first, last };
}

function authorPositionLabel(a: {
  isFirst: boolean;
  isLast: boolean;
  isPenultimate: boolean;
  totalAuthors: number;
}): string {
  if (a.totalAuthors === 1) return "first_and_last";
  if (a.isFirst && a.isLast) return "first_and_last";
  if (a.isFirst) return "first";
  if (a.isLast) return "last";
  if (a.isPenultimate) return "penultimate";
  return "middle";
}

/** Run the OpenSearch query with the export-tuned size and return
 *  ordered pmids. Mirrors the filter logic in `searchPublications`
 *  but skips aggregations and only fetches the pmid field. */
async function fetchExportPmids(req: ExportRequest): Promise<string[]> {
  const trimmed = req.q.trim();
  const filters = req.filters ?? {};
  const sort = req.sort ?? "relevance";
  const size = Math.min(req.limit ?? EXPORT_MAX_LIMIT, EXPORT_MAX_LIMIT);

  const must: Record<string, unknown>[] = [];
  if (trimmed.length > 0) {
    must.push({
      multi_match: {
        query: trimmed,
        fields: [...PUBLICATION_FIELD_BOOSTS],
        type: "best_fields",
      },
    });
  } else {
    must.push({ match_all: {} });
  }

  const filter: Record<string, unknown>[] = [];
  if (filters.yearMin !== undefined || filters.yearMax !== undefined) {
    const range: Record<string, number> = {};
    if (filters.yearMin !== undefined) range.gte = filters.yearMin;
    if (filters.yearMax !== undefined) range.lte = filters.yearMax;
    filter.push({ range: { year: range } });
  }
  if (filters.publicationType) {
    filter.push({ term: { publicationType: filters.publicationType } });
  }
  if (filters.journal && filters.journal.length > 0) {
    filter.push({ terms: { "journal.keyword": filters.journal } });
  }
  if (filters.wcmAuthorRole && filters.wcmAuthorRole.length > 0) {
    filter.push({ terms: { wcmAuthorPositions: filters.wcmAuthorRole } });
  }
  if (filters.wcmAuthor && filters.wcmAuthor.length > 0) {
    filter.push({ terms: { wcmAuthorCwids: filters.wcmAuthor } });
  }

  const sortClause: Record<string, "asc" | "desc">[] = [];
  if (sort === "year") sortClause.push({ year: "desc" });
  else if (sort === "citations") sortClause.push({ citationCount: "desc" });

  const body = {
    from: 0,
    size,
    track_total_hits: false,
    query: { bool: { must, filter } },
    ...(sortClause.length > 0 ? { sort: sortClause } : {}),
    _source: ["pmid"],
  };

  const resp = await searchClient().search({
    index: PUBLICATIONS_INDEX,
    body: body as object,
  });
  type Hit = { _source: { pmid: string } };
  const r = resp.body as unknown as { hits: { hits: Hit[] } };
  return r.hits.hits.map((h) => h._source.pmid);
}

/** Hydrate ordered pmids into authorship rows. Each WCM author confirmed
 *  on a publication produces one row; the publication metadata repeats. */
export async function fetchAuthorshipRows(
  req: ExportRequest,
): Promise<AuthorshipRow[]> {
  const pmids = await fetchExportPmids(req);
  if (pmids.length === 0) return [];

  const pubs = await prisma.publication.findMany({
    where: { pmid: { in: pmids } },
    include: {
      authors: {
        where: {
          isConfirmed: true,
          cwid: { not: null },
          scholar: { deletedAt: null, status: "active" },
        },
        orderBy: { position: "asc" },
        include: {
          scholar: {
            select: {
              cwid: true,
              preferredName: true,
              primaryDepartment: true,
            },
          },
        },
      },
    },
  });
  const byPmid = new Map(pubs.map((p) => [p.pmid, p]));

  const rows: AuthorshipRow[] = [];
  for (const pmid of pmids) {
    const pub = byPmid.get(pmid);
    if (!pub) continue;
    const authorsClean = stripBrackets(pub.authorsString);
    for (const a of pub.authors) {
      if (!a.scholar) continue;
      const { first, last } = splitName(a.scholar.preferredName);
      rows.push({
        personIdentifier: a.scholar.cwid,
        lastName: last,
        firstName: first,
        primaryDepartment: a.scholar.primaryDepartment,
        pmid: pub.pmid,
        title: plainTitleForCsv(pub.title),
        year: pub.year,
        journal: pub.journal,
        doi: pub.doi,
        pmcid: pub.pmcid,
        dateAddedToEntrez: pub.dateAddedToEntrez
          ? pub.dateAddedToEntrez.toISOString().slice(0, 10)
          : null,
        citationCount: pub.citationCount,
        publicationType: pub.publicationType,
        authors: authorsClean,
        authorPosition: stripBrackets(authorPositionLabel(a)),
      });
    }
  }
  return rows;
}

/** Hydrate ordered pmids into one-row-per-article shape. */
export async function fetchArticleRows(
  req: ExportRequest,
): Promise<ArticleRow[]> {
  const pmids = await fetchExportPmids(req);
  if (pmids.length === 0) return [];

  const pubs = await prisma.publication.findMany({
    where: { pmid: { in: pmids } },
    select: {
      pmid: true,
      title: true,
      year: true,
      journal: true,
      doi: true,
      pmcid: true,
      dateAddedToEntrez: true,
      citationCount: true,
      publicationType: true,
      authorsString: true,
    },
  });
  const byPmid = new Map(pubs.map((p) => [p.pmid, p]));

  const rows: ArticleRow[] = [];
  for (const pmid of pmids) {
    const pub = byPmid.get(pmid);
    if (!pub) continue;
    rows.push({
      pmid: pub.pmid,
      title: plainTitleForCsv(pub.title),
      year: pub.year,
      journal: pub.journal,
      doi: pub.doi,
      pmcid: pub.pmcid,
      dateAddedToEntrez: pub.dateAddedToEntrez
        ? pub.dateAddedToEntrez.toISOString().slice(0, 10)
        : null,
      citationCount: pub.citationCount,
      publicationType: pub.publicationType,
      authors: stripBrackets(pub.authorsString),
    });
  }
  return rows;
}

export const AUTHORSHIP_HEADERS: ReadonlyArray<keyof AuthorshipRow> = [
  "personIdentifier",
  "lastName",
  "firstName",
  "primaryDepartment",
  "pmid",
  "title",
  "year",
  "journal",
  "doi",
  "pmcid",
  "dateAddedToEntrez",
  "citationCount",
  "publicationType",
  "authors",
  "authorPosition",
];

export const ARTICLE_HEADERS: ReadonlyArray<keyof ArticleRow> = [
  "pmid",
  "title",
  "year",
  "journal",
  "doi",
  "pmcid",
  "dateAddedToEntrez",
  "citationCount",
  "publicationType",
  "authors",
];
