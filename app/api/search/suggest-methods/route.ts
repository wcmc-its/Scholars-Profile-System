/**
 * GET /api/search/suggest-methods?q= — the home page "Find a method" typeahead
 * (`suggestMethodFinder`: subareas, then method families). Public, like
 * `/api/search/suggest`; no autocomplete telemetry, so the #231 hero metrics
 * stay about the hero box. CloudFront already keys every query string on
 * `/api/search*`.
 */
import { NextResponse, type NextRequest } from "next/server";

import { suggestMethodFinder } from "@/lib/api/search";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const suggestions = await suggestMethodFinder(request.nextUrl.searchParams.get("q") ?? "");
  return NextResponse.json({ suggestions });
}
