import { NextResponse } from "next/server";
import { getPublicationDetail } from "@/lib/api/publication-detail";

/**
 * GET /api/publications/:pmid
 *
 * Returns the payload backing the publication detail modal (#288 PR-B):
 * pub fields, collapsed multi-author topic rows, and a capped list of
 * citing publications from reciterdb (soft-fails to null on reciterdb
 * outage so the rest of the modal still renders).
 *
 * Thin delegator over `lib/api/publication-detail.ts` — same separation
 * pattern as `/api/scholars/[cwid]/route.ts`.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ pmid: string }> },
) {
  const { pmid } = await context.params;
  const payload = await getPublicationDetail(pmid);
  if (!payload) {
    return NextResponse.json(
      { error: "Publication not found" },
      { status: 404 },
    );
  }
  return NextResponse.json(payload);
}
