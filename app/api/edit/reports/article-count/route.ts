/**
 * GET /api/edit/reports/article-count — report 8 (Article counts) as a
 * three-sheet `.xlsx`: "Counts" (one row per year + total), "Criteria" (the
 * filters, the counting rule and the caveat) and "Articles" (one row per
 * counted article with its matching scholars — only up to `ARTICLE_LIST_CAP`;
 * above it the sheet says so instead). Same query string as the page
 * (`parseArticleCountParams`), same gate (`canViewArticleCountReport`); the
 * Criteria sheet names selected units from the rail's own facets.
 * No session → 401 · not an administrator → 403. `no-store`: never cached.
 */
import { NextResponse } from "next/server";

import { loadDataQualityFacets } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  ARTICLE_LIST_CAP,
  BASIS_LABEL,
  buildArticleCountWorkbook,
  canViewArticleCountReport,
  loadArticleCounts,
  loadArticleList,
  parseArticleCountParams,
  unitLabels,
} from "@/lib/edit/article-count-report";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  if (!(await canViewArticleCountReport(session))) return new NextResponse("Forbidden", { status: 403 });

  const params = parseArticleCountParams(new URL(request.url).searchParams);
  const generatedAt = new Date();
  const { rows, total } = await loadArticleCounts(params);
  const articles = total <= ARTICLE_LIST_CAP ? await loadArticleList(params) : null;
  const labels = params.units.length > 0 ? unitLabels(await loadDataQualityFacets(db.read)) : undefined;
  const buffer = await buildArticleCountWorkbook(params, rows, total, generatedAt, articles, labels);
  const filename = `Article counts ${BASIS_LABEL[params.basis].split(" ")[0]} ${params.from}-${params.to} ${generatedAt.toISOString().slice(0, 10)}.xlsx`;

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
