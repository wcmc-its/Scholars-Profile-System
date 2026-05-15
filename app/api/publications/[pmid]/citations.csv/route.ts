import { NextResponse } from "next/server";
import {
  getCitingPublicationsForCsv,
  serializeCitingPubsCsv,
} from "@/lib/api/publication-detail";

/**
 * GET /api/publications/:pmid/citations.csv
 *
 * Streams the full citing-publications list for a pmid as a downloadable
 * CSV. Capped server-side (see `getCitingPublicationsForCsv`) far higher
 * than the modal's inline 500-row window so highly cited papers
 * (thousands of citers) export completely. Used by the "Download CSV"
 * affordance in the publication detail modal's Cited by section.
 *
 * Returns 400 for invalid pmid, 502 if reciterdb is unreachable.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ pmid: string }> },
) {
  const { pmid } = await context.params;
  let rows;
  try {
    rows = await getCitingPublicationsForCsv(pmid);
  } catch (err) {
    console.error("[citations.csv] reciterdb fetch failed", err);
    return NextResponse.json(
      { error: "Citation source unavailable" },
      { status: 502 },
    );
  }
  if (rows === null) {
    return NextResponse.json({ error: "Invalid pmid" }, { status: 400 });
  }
  const csv = serializeCitingPubsCsv(rows);
  // Filename gets the cited pmid for at-a-glance identification in the
  // user's downloads folder.
  const filename = `pmid-${pmid}-citations.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
