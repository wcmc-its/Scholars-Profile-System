/**
 * /api/scholars/[cwid]/popover-context — the #853 method-families plumbing.
 *
 * The popover-context route shares surface="top-scholar" between topic pages and
 * /methods pages, so the section MUST be gated on a dedicated `contextMethods`
 * param AND `isMethodPagesEnabled()` — never leaking into topic-page top-scholar
 * popovers. These cases assert that contract:
 *   1. param + flag on  ⇒ methodFamilies present, loader called once with cwid.
 *   2. param + flag off ⇒ [] and loader NOT called (no leak).
 *   3. contextTopicSlug (topic page), no param ⇒ [] and loader NOT called.
 *   4. wrong surface (pub-chip) ⇒ [] and loader NOT called.
 *
 * The popover-context fetchers are mocked to a minimal header so the route doesn't
 * 404, and getScholarMethodFamilies is mocked to a sentinel array.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockFetchPopoverHeader,
  mockGetScholarMethodFamilies,
  mockIsMethodPagesEnabled,
} = vi.hoisted(() => ({
  mockFetchPopoverHeader: vi.fn(),
  mockGetScholarMethodFamilies: vi.fn(),
  mockIsMethodPagesEnabled: vi.fn(),
}));

vi.mock("@/lib/api/popover-context", () => ({
  fetchPopoverHeader: (...a: unknown[]) => mockFetchPopoverHeader(...a),
  fetchAuthorshipOnPub: vi.fn(async () => null),
  fetchCoPubsSummary: vi.fn(async () => null),
  fetchInvestigatorTopSponsor: vi.fn(async () => null),
  fetchRecentActiveGrants: vi.fn(async () => []),
  fetchRecentPubs: vi.fn(async () => []),
  fetchTopicRank: vi.fn(async () => null),
}));

vi.mock("@/lib/api/methods", () => ({
  getScholarMethodFamilies: (...a: unknown[]) => mockGetScholarMethodFamilies(...a),
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodPagesEnabled: () => mockIsMethodPagesEnabled(),
}));

import { GET } from "@/app/api/scholars/[cwid]/popover-context/route";

const CWID = "abc1234";

const SAMPLE_FAMILIES = [
  {
    supercategory: "imaging_image_analysis",
    familyLabel: "Deep learning",
    familyId: "fam_0001",
    pmidCount: 12,
    href: "/methods/imaging-image-analysis/deep-learning-fam_0001",
  },
];

function call(query: string) {
  const req = new NextRequest(`http://localhost/api/scholars/${CWID}/popover-context${query}`, {
    method: "GET",
  });
  return GET(req, { params: Promise.resolve({ cwid: CWID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchPopoverHeader.mockResolvedValue({
    cwid: CWID,
    preferredName: "Jane Doe",
    postnominal: null,
    primaryTitle: null,
    primaryDepartment: null,
    slug: "jane-doe",
    identityImageEndpoint: "/img",
    totalPubCount: 10,
    totalGrantCount: 0,
    topTopic: null,
  });
  mockGetScholarMethodFamilies.mockResolvedValue(SAMPLE_FAMILIES);
  mockIsMethodPagesEnabled.mockReturnValue(true);
});

describe("popover-context route — #853 methodFamilies", () => {
  it("returns methodFamilies for top-scholar + contextMethods=1 with the flag ON", async () => {
    const res = await call("?surface=top-scholar&contextMethods=1");
    const body = await res.json();

    expect(body.methodFamilies).toEqual(SAMPLE_FAMILIES);
    expect(mockGetScholarMethodFamilies).toHaveBeenCalledTimes(1);
    expect(mockGetScholarMethodFamilies).toHaveBeenCalledWith(CWID);
  });

  it("omits methodFamilies (=== []) and does NOT call the loader when the flag is OFF", async () => {
    mockIsMethodPagesEnabled.mockReturnValue(false);

    const res = await call("?surface=top-scholar&contextMethods=1");
    const body = await res.json();

    expect(body.methodFamilies).toEqual([]);
    expect(mockGetScholarMethodFamilies).not.toHaveBeenCalled();
  });

  it("does NOT leak into topic-page popovers (contextTopicSlug set, contextMethods absent)", async () => {
    const res = await call("?surface=top-scholar&contextTopicSlug=oncology");
    const body = await res.json();

    expect(body.methodFamilies).toEqual([]);
    expect(mockGetScholarMethodFamilies).not.toHaveBeenCalled();
  });

  it("only qualifies for the top-scholar surface (pub-chip + contextMethods=1 ⇒ [])", async () => {
    const res = await call("?surface=pub-chip&contextMethods=1&contextPubPmid=123");
    const body = await res.json();

    expect(body.methodFamilies).toEqual([]);
    expect(mockGetScholarMethodFamilies).not.toHaveBeenCalled();
  });
});
