import { NextResponse, type NextRequest } from "next/server";
import {
  fetchAuthorshipOnPub,
  fetchCoPubsSummary,
  fetchPopoverHeader,
  fetchRecentPubs,
  fetchTopicRank,
} from "@/lib/api/popover-context";

export const dynamic = "force-dynamic";

/**
 * Contextual data for the <PersonPopover> body (#242).
 *
 * Single round-trip per popover open. Branches the work by `surface` so we
 * don't pay for lookups we won't render. All optional context props are read
 * from the query string; unknown surfaces fall back to header + total counts
 * only.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cwid: string }> },
) {
  const { cwid } = await params;
  const sp = request.nextUrl.searchParams;
  const surface = sp.get("surface") ?? "";
  const contextScholarCwid = sp.get("contextScholarCwid") || undefined;
  const contextPubPmid = sp.get("contextPubPmid") || undefined;
  const contextTopicSlug = sp.get("contextTopicSlug") || undefined;

  const header = await fetchPopoverHeader(cwid);
  if (!header) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Per-surface contextual lookups. Each is independent so a single failure
  // doesn't blank the popover — Promise.allSettled keeps the header + counts
  // visible even if a lookup throws.
  const wantsAuthorship =
    !!contextPubPmid && (surface === "pub-chip" || surface === "co-author");
  const wantsCoPubs = !!contextScholarCwid && surface !== "facet";
  const wantsTopicRank = !!contextTopicSlug && surface === "top-scholar";
  const wantsRecentPubs =
    surface === "pub-chip" ||
    surface === "co-author" ||
    (surface === "top-scholar" && !contextTopicSlug);

  const [authorshipR, coPubsR, topicRankR, recentR] = await Promise.allSettled([
    wantsAuthorship ? fetchAuthorshipOnPub(cwid, contextPubPmid!) : Promise.resolve(null),
    wantsCoPubs ? fetchCoPubsSummary(cwid, contextScholarCwid!) : Promise.resolve(null),
    wantsTopicRank ? fetchTopicRank(cwid, contextTopicSlug!) : Promise.resolve(null),
    wantsRecentPubs ? fetchRecentPubs(cwid, 2) : Promise.resolve([]),
  ]);
  const unwrap = <T>(r: PromiseSettledResult<T>, fb: T): T =>
    r.status === "fulfilled" ? r.value : fb;

  return NextResponse.json({
    header,
    authorship: unwrap(authorshipR, null),
    coPubs: unwrap(coPubsR, null),
    topicRank: unwrap(topicRankR, null),
    recentPubs: unwrap(recentR, []),
  });
}
