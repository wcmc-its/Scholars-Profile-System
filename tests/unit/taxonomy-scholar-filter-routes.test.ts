/**
 * Phase 3 (TAXONOMY_SCHOLAR_CARDS) — the `cwid` param on the topic and method
 * family publication routes.
 *
 *   - flag on: a malformed cwid is a 400 with a static message (no echo) and
 *     never reaches the loader; a well-formed one is forwarded;
 *   - flag off: the param is ignored entirely (pre-flag behavior), even when
 *     malformed;
 *   - no response memoization: two different cwids reach the loader as two
 *     different calls (both routes are CachingDisabled at the edge, so the
 *     cwid never needs a cache key there — this guards the origin side).
 *
 * Fake cwids only (public repo).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetTopicPublications, mockGetFamily, mockGetFamilyPublications } = vi.hoisted(() => ({
  mockGetTopicPublications: vi.fn(),
  mockGetFamily: vi.fn(),
  mockGetFamilyPublications: vi.fn(),
}));

vi.mock("@/lib/api/topics", () => ({ getTopicPublications: mockGetTopicPublications }));
vi.mock("@/lib/api/methods", () => ({
  getFamily: mockGetFamily,
  getFamilyPublications: mockGetFamilyPublications,
}));

import { GET as topicGET } from "@/app/api/topics/[slug]/publications/route";
import { GET as familyGET } from "@/app/api/methods/[supercategory]/[family]/publications/route";

const topicReq = (qs: string) =>
  topicGET(new NextRequest(new URL(`http://localhost/api/topics/cardio/publications?${qs}`)), {
    params: Promise.resolve({ slug: "cardio" }),
  });
const familyReq = (qs: string) =>
  familyGET(
    new NextRequest(
      new URL(`http://localhost/api/methods/imaging/mri-fam_0001/publications?${qs}`),
    ),
    { params: Promise.resolve({ supercategory: "imaging", family: "mri-fam_0001" }) },
  );

const BAD_CWIDS = ["AAA1111", "a", "aaa-1111", "aaa1111' OR 1=1", "", "x".repeat(40), "1aa1111"];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTopicPublications.mockResolvedValue({ hits: [], total: 0, page: 0, pageSize: 20 });
  mockGetFamily.mockResolvedValue({ supercategory: "imaging_x", familyLabel: "MRI" });
  mockGetFamilyPublications.mockResolvedValue({ hits: [], total: 0, page: 0, pageSize: 20 });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("flag on", () => {
  beforeEach(() => vi.stubEnv("TAXONOMY_SCHOLAR_CARDS", "on"));

  it.each(BAD_CWIDS)("topic route rejects cwid %j with 400", async (bad) => {
    const res = await topicReq(`sort=newest&cwid=${encodeURIComponent(bad)}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid cwid");
    expect(mockGetTopicPublications).not.toHaveBeenCalled();
  });

  it.each(BAD_CWIDS)("family route rejects cwid %j with 400", async (bad) => {
    const res = await familyReq(`sort=newest&cwid=${encodeURIComponent(bad)}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid cwid");
    expect(mockGetFamily).not.toHaveBeenCalled();
    expect(mockGetFamilyPublications).not.toHaveBeenCalled();
  });

  it("forwards a valid cwid to the topic loader", async () => {
    const res = await topicReq("sort=newest&subtopic=s1&cwid=aaa1111");
    expect(res.status).toBe(200);
    expect(mockGetTopicPublications).toHaveBeenCalledWith("cardio", {
      sort: "newest",
      subtopic: "s1",
      page: 0,
      filter: "research_articles_only",
      tier: undefined,
      cwid: "aaa1111",
    });
  });

  it("forwards a valid cwid to the family loader", async () => {
    const res = await familyReq("sort=newest&cwid=aaa1111");
    expect(res.status).toBe(200);
    expect(mockGetFamilyPublications).toHaveBeenCalledWith("imaging_x", "MRI", {
      sort: "newest",
      page: 0,
      filter: "research_articles_only",
      entityId: undefined,
      cwid: "aaa1111",
    });
  });

  it("different cwids are different loader calls (no memoized response)", async () => {
    await topicReq("sort=newest&cwid=aaa1111");
    await topicReq("sort=newest&cwid=ccc3333");
    await familyReq("sort=newest&cwid=aaa1111");
    await familyReq("sort=newest&cwid=ccc3333");
    expect(mockGetTopicPublications.mock.calls.map((c) => c[1].cwid)).toEqual([
      "aaa1111",
      "ccc3333",
    ]);
    expect(mockGetFamilyPublications.mock.calls.map((c) => c[2].cwid)).toEqual([
      "aaa1111",
      "ccc3333",
    ]);
  });

  it("no cwid param → no cwid key", async () => {
    await topicReq("sort=newest");
    await familyReq("sort=newest");
    expect("cwid" in mockGetTopicPublications.mock.calls[0][1]).toBe(false);
    expect("cwid" in mockGetFamilyPublications.mock.calls[0][2]).toBe(false);
  });
});

describe("flag off (default)", () => {
  it("ignores even a malformed cwid on both routes", async () => {
    const t = await topicReq("sort=newest&cwid=NOT_VALID!");
    const f = await familyReq("sort=newest&cwid=NOT_VALID!");
    expect(t.status).toBe(200);
    expect(f.status).toBe(200);
    expect("cwid" in mockGetTopicPublications.mock.calls[0][1]).toBe(false);
    expect("cwid" in mockGetFamilyPublications.mock.calls[0][2]).toBe(false);
  });

  it("ignores a valid cwid too", async () => {
    await topicReq("sort=newest&cwid=aaa1111");
    expect("cwid" in mockGetTopicPublications.mock.calls[0][1]).toBe(false);
  });
});
