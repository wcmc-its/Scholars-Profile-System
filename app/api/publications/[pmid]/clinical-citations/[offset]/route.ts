import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/error-response";
import { getClinicalCitationsPage } from "@/lib/api/publication-detail";

/**
 * GET /api/publications/:pmid/clinical-citations/:offset
 *
 * One page of the publication modal's "Clinical studies" group, newest first:
 * `{ items, count, total }`. The modal payload carries the first page; "Show
 * more" asks for the next one here. `offset` is a whole multiple of the page
 * size and sits in the path, not the query string: this route is served by the
 * edge's cacheable default behavior, which strips query parameters.
 *
 * 404 when `CLINICAL_CITATIONS_MODAL` is off, the pmid or offset is not valid,
 * the publication is one the modal would not show, or it has no clinical
 * studies. 500 when the read failed.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ pmid: string; offset: string }> },
) {
  const { pmid, offset } = await context.params;
  const result = await getClinicalCitationsPage(pmid, offset);
  if (result.status === "unavailable") {
    return apiError("Clinical studies unavailable", 500);
  }
  if (result.status === "not_found") {
    return apiError("Not found", 404);
  }
  return NextResponse.json(result.page);
}
