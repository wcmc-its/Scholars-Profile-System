/**
 * GET /api/edit/reports/article-count — report 8 (Article counts) as a
 * three-sheet `.xlsx`: "Counts" (one row per year + total), "Criteria" (the
 * filters, the counting rule and the caveat) and "Articles" (one row per
 * counted article with its matching scholars — only up to `ARTICLE_LIST_CAP`;
 * above it the sheet says so instead). Same query string as the page
 * (`parseArticleCountParams` + `resolveArticleCountParams`: a bare URL gets
 * the viewer's units, a `list` is resolved), same gate
 * (`canViewArticleCountReport`); the Criteria sheet names selected units from
 * the rail's own facets and states the CWID list and the window.
 * No session → 401 · not an administrator → 403. `no-store`: never cached.
 */
import { NextResponse } from "next/server";

import { loadDataQualityFacets } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  ARTICLE_COUNT_PARSE,
  ARTICLE_LIST_CAP,
  BASIS_LABEL,
  buildArticleCountWorkbook,
  canViewArticleCountReport,
  loadArticleCounts,
  loadArticleList,
  parseArticleCountParams,
  resolveArticleCountParams,
  unitLabels,
} from "@/lib/edit/article-count-report";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  if (!(await canViewArticleCountReport(session))) return new NextResponse("Forbidden", { status: 403 });

  const sp = new URL(request.url).searchParams;
  const { params } = await resolveArticleCountParams(parseArticleCountParams(sp, ARTICLE_COUNT_PARSE), sp, session);
  const generatedAt = new Date();
  const { rows, total } = await loadArticleCounts(params);
  const articles = total <= ARTICLE_LIST_CAP ? await loadArticleList(params) : null;
  const labels = params.units.length > 0 ? unitLabels(await loadDataQualityFacets(db.read)) : undefined;
  const buffer = await buildArticleCountWorkbook(params, rows, total, generatedAt, articles, labels);
  const span = params.added
    ? `Added ${params.added.from} to ${params.added.to}`
    : `${BASIS_LABEL[params.basis].split(" ")[0]} ${params.from}-${params.to}`;
  const filename = `Article counts ${span} ${generatedAt.toISOString().slice(0, 10)}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(buffer.byteLength),
      "cache-control": "no-store",
    },
  });
}
