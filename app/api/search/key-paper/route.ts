import { NextResponse, type NextRequest } from "next/server";

import { fetchKeyPaper } from "@/lib/api/search";
import { resolvePeopleReasonFromDoc } from "@/lib/api/search-flags";

export const dynamic = "force-dynamic";

/**
 * Search reason-from-doc (lazy key papers, §5) — the on-the-fly, per-card key
 * paper endpoint. The People result card calls this when it enters the viewport
 * (or is expanded), so the concept-tagged, `<mark>`-highlighted representative
 * publication is fetched only for cards the user actually views — off the initial
 * render's critical path. `fetchKeyPaper` dedupes + caches by (cwid, concept).
 *
 * ponytail (full): a Route Handler, NOT a Next.js `"use server"` action — this
 * repo has zero server-action precedent and every other client→server fetch
 * (autocomplete, opportunities) is a route handler, so this rides the established
 * pattern (GET + force-dynamic + NextResponse.json) rather than introducing a new
 * server-action surface. Same public, unauthenticated read posture as
 * `/api/search/suggest`; no mutation, no PII.
 *
 * Gated on `SEARCH_PEOPLE_REASON_FROM_DOC`: the lazy key paper is the companion to
 * the doc-sourced count, so when the flag is off this endpoint returns null (the
 * inline rep-pub path — `SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB` — still serves
 * the up-front key paper in that posture).
 */
export async function GET(request: NextRequest) {
  if (!resolvePeopleReasonFromDoc()) {
    return NextResponse.json({ pubs: [] });
  }
  const params = request.nextUrl.searchParams;
  const cwid = params.get("cwid") ?? "";
  const contentQuery = params.get("q") ?? "";
  const descriptorUis = (params.get("descriptorUis") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const pubs = await fetchKeyPaper({ cwid, descriptorUis, contentQuery });
  return NextResponse.json({ pubs });
}
