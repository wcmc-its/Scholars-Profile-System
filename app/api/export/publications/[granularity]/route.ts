/**
 * POST /api/export/publications/{authorship|article}
 *
 * CSV export of the current Publications-tab result set (#89 Phase 1).
 * Body shape mirrors what the search results page already sends to
 * /api/search?type=publications, so the client can pass through the
 * exact filter object it constructed for the live results.
 *
 * Returns text/csv with Content-Disposition: attachment so a fetch+Blob
 * anchor download lands the file with the correct name. Filenames follow
 * `{ReportType}-Scholars-{YYYY-MM-DD}.csv` per spec §6.5.
 *
 * Security:
 *   - Granularity path param against a fixed allowlist
 *   - JSON body parsed defensively; structurally invalid → 400
 *   - Filter values constrained to the same shape `searchPublications`
 *     accepts; OpenSearch handles further escaping
 *   - No auth gating in Phase 1 (mirrors the rest of /search/* routes);
 *     rate limiting deferred to Phase 2
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  AUTHORSHIP_HEADERS,
  ARTICLE_HEADERS,
  EXPORT_MAX_LIMIT,
  fetchAuthorshipRows,
  fetchArticleRows,
  type ExportGranularity,
  type ExportRequest,
} from "@/lib/api/export-publications";
import {
  WORD_MAX_LIMIT,
  generateWordBibliography,
} from "@/lib/api/word-bibliography";
import type {
  PublicationsFilters,
  PublicationsSort,
  WcmAuthorRole,
} from "@/lib/api/search";
import { toCsv, type CsvCell } from "@/lib/csv";

export const dynamic = "force-dynamic";
// Up to 5,000-row CSVs require a few seconds of DB hydration; raise the
// default 10s edge timeout so we can finish even on a cold cache.
export const maxDuration = 60;

type RouteGranularity = ExportGranularity | "bibliography";

const GRANULARITY_ALLOWLIST: ReadonlySet<RouteGranularity> = new Set([
  "authorship",
  "article",
  "bibliography",
]);
const SORT_ALLOWLIST: ReadonlySet<PublicationsSort> = new Set([
  "relevance",
  "year",
  "citations",
]);
const ROLE_ALLOWLIST: ReadonlySet<WcmAuthorRole> = new Set([
  "first",
  "senior",
  "middle",
]);

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Coerce an untrusted JSON body into a typed ExportRequest. Anything
 *  that doesn't fit the contract is dropped silently rather than echoed
 *  back, matching the rest of /api/search/* defensive parsing. */
function parseBody(body: unknown): ExportRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  const q = typeof b.q === "string" ? b.q : "";
  const sort = SORT_ALLOWLIST.has(b.sort as PublicationsSort)
    ? (b.sort as PublicationsSort)
    : undefined;

  const f = (b.filters && typeof b.filters === "object" ? b.filters : {}) as Record<string, unknown>;
  const filters: PublicationsFilters = {};
  if (typeof f.yearMin === "number") filters.yearMin = f.yearMin;
  if (typeof f.yearMax === "number") filters.yearMax = f.yearMax;
  if (typeof f.publicationType === "string") filters.publicationType = f.publicationType;
  if (isStringArray(f.journal)) filters.journal = f.journal;
  if (isStringArray(f.wcmAuthorRole)) {
    const roles = f.wcmAuthorRole.filter((r): r is WcmAuthorRole =>
      ROLE_ALLOWLIST.has(r as WcmAuthorRole),
    );
    if (roles.length > 0) filters.wcmAuthorRole = roles;
  }
  if (isStringArray(f.wcmAuthor)) filters.wcmAuthor = f.wcmAuthor;

  // limit clamp happens per-granularity inside the fetcher (CSVs cap at
  // 5,000; Word at 1,000). Pass the raw user value through; the fetcher
  // applies the per-format ceiling.
  let limit: number | undefined;
  if (typeof b.limit === "number" && Number.isFinite(b.limit) && b.limit > 0) {
    limit = Math.floor(b.limit);
  }

  return { q, sort, filters, limit };
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ granularity: string }> },
) {
  const { granularity: raw } = await ctx.params;
  if (!GRANULARITY_ALLOWLIST.has(raw as RouteGranularity)) {
    return NextResponse.json({ error: "invalid granularity" }, { status: 400 });
  }
  const granularity = raw as RouteGranularity;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const req = parseBody(body);
  if (!req) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (granularity === "bibliography") {
    const { buffer, rowCount } = await generateWordBibliography({
      q: req.q,
      filters: req.filters,
      sort: req.sort,
      limit: req.limit !== undefined ? Math.min(req.limit, WORD_MAX_LIMIT) : undefined,
    });
    const filename = `Bibliography-Scholars-${todayStamp()}.docx`;
    console.log(
      JSON.stringify({
        event: "export_publications",
        granularity,
        q: req.q,
        filters: req.filters,
        sort: req.sort,
        rowCount,
        ts: new Date().toISOString(),
      }),
    );
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const csvReq: ExportRequest = {
    q: req.q,
    filters: req.filters,
    sort: req.sort,
    limit: req.limit !== undefined ? Math.min(req.limit, EXPORT_MAX_LIMIT) : undefined,
  };
  const headers: ReadonlyArray<string> =
    granularity === "authorship" ? AUTHORSHIP_HEADERS : ARTICLE_HEADERS;
  const rows = granularity === "authorship"
    ? await fetchAuthorshipRows(csvReq)
    : await fetchArticleRows(csvReq);

  const csvRows = rows.map(
    (r) => headers.map((h) => (r as Record<string, CsvCell>)[h]),
  );
  const csv = toCsv(headers, csvRows);

  const reportName = granularity === "authorship"
    ? "AuthorshipReport"
    : "ArticleReport";
  const filename = `${reportName}-Scholars-${todayStamp()}.csv`;

  // Structured access log mirrors the search-query log shape so analytics
  // can join exports against query patterns. No PII beyond the search
  // surface itself.
  console.log(
    JSON.stringify({
      event: "export_publications",
      granularity,
      q: req.q,
      filters: req.filters,
      sort: req.sort,
      rowCount: rows.length,
      ts: new Date().toISOString(),
    }),
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
