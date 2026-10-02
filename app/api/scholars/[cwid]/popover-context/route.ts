import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import {
  fetchAuthorshipOnPub,
  fetchCoPubsSummary,
  fetchInvestigatorTopSponsor,
  fetchPopoverHeader,
  fetchRecentActiveGrants,
  fetchRecentPubs,
  fetchTopicRank,
  fetchTopicScopePmids,
  summarizeScope,
} from "@/lib/api/popover-context";
import { getScholarMethodFamilies, getScholarMethodScopePmids } from "@/lib/api/methods";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";

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
  const contextGrantProjectId = sp.get("contextGrantProjectId") || undefined;
  // #853 — a dedicated boolean param is the ONLY safe disambiguator: both topic
  // and methods top-scholar chips share surface="top-scholar"; topic chips always
  // pass contextTopicSlug, methods chips never do. Keying off this param (not the
  // absence of contextTopicSlug, which also serves generic top-scholar popovers)
  // lights up the method-families section only for /methods, never leaking into
  // topic pages.
  const contextMethods = sp.get("contextMethods") === "1";
  // Taxonomy-card surface (topic / method page scholar cards): the page's scope
  // is a topic (contextTopicSlug) or a method supercategory, optionally one
  // family in it (supercategory id + family label, the family feed's own key).
  const contextSupercategory = sp.get("contextSupercategory") || undefined;
  const contextFamilyLabel = sp.get("contextFamilyLabel") || undefined;

  // Started alongside the contextual lookups below (hover latency); the 404
  // still gates the response, so a hidden scholar's lookup results are discarded.
  const headerP = fetchPopoverHeader(cwid);

  // Per-surface contextual lookups. Each is independent so a single failure
  // doesn't blank the popover — Promise.allSettled keeps the header + counts
  // visible even if a lookup throws.
  const wantsAuthorship =
    !!contextPubPmid && (surface === "pub-chip" || surface === "co-author");
  const wantsCoPubs = !!contextScholarCwid && surface !== "facet";
  const wantsTopicRank = !!contextTopicSlug && surface === "top-scholar";
  const isCard = surface === "taxonomy-card";
  const wantsScope =
    isCard && (!!contextTopicSlug || (!!contextSupercategory && isMethodPagesEnabled()));
  const wantsRecentPubs =
    surface === "pub-chip" ||
    surface === "co-author" ||
    (surface === "top-scholar" && !contextTopicSlug);
  const wantsRecentGrants = surface === "grant-investigator";
  const wantsTopSponsor = surface === "grant-facet";
  // #853 — the method-families section is gated by BOTH the dedicated /methods
  // param AND the page/surface flag. getScholarMethodFamilies also self-gates on
  // the master lens flag, so flag-off on EITHER ⇒ []. Param absent ⇒ never queried.
  const wantsMethodFamilies =
    contextMethods && surface === "top-scholar" && isMethodPagesEnabled();

  const lookupsP = Promise.allSettled([
    wantsAuthorship ? fetchAuthorshipOnPub(cwid, contextPubPmid!) : Promise.resolve(null),
    wantsCoPubs ? fetchCoPubsSummary(cwid, contextScholarCwid!) : Promise.resolve(null),
    wantsTopicRank ? fetchTopicRank(cwid, contextTopicSlug!) : Promise.resolve(null),
    wantsRecentPubs ? fetchRecentPubs(cwid, 2) : Promise.resolve([]),
    wantsRecentGrants
      ? fetchRecentActiveGrants(cwid, { limit: 2, excludeProjectId: contextGrantProjectId })
      : Promise.resolve([]),
    wantsTopSponsor ? fetchInvestigatorTopSponsor(cwid) : Promise.resolve(null),
    wantsMethodFamilies ? getScholarMethodFamilies(cwid) : Promise.resolve([]),
    wantsScope
      ? (contextTopicSlug
          ? fetchTopicScopePmids(cwid, contextTopicSlug)
          : getScholarMethodScopePmids(cwid, contextSupercategory!, contextFamilyLabel)
        ).then((pmids) => summarizeScope(cwid, pmids))
      : Promise.resolve(null),
  ]);

  const header = await headerP;
  if (!header) {
    return apiError("not found", 404);
  }
  const [
    authorshipR,
    coPubsR,
    topicRankR,
    recentR,
    recentGrantsR,
    topSponsorR,
    methodFamiliesR,
    scopeR,
  ] = await lookupsP;
  const unwrap = <T>(r: PromiseSettledResult<T>, fb: T): T =>
    r.status === "fulfilled" ? r.value : fb;

  return NextResponse.json({
    header,
    authorship: unwrap(authorshipR, null),
    coPubs: unwrap(coPubsR, null),
    topicRank: unwrap(topicRankR, null),
    recentPubs: unwrap(recentR, []),
    recentGrants: unwrap(recentGrantsR, []),
    topSponsor: unwrap(topSponsorR, null),
    methodFamilies: unwrap(methodFamiliesR, []),
    scope: unwrap(scopeR, null),
  });
}
