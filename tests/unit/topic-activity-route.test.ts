/**
 * app/api/topics/[slug]/activity/route.ts (TOPIC_FEED_GRANTS_TRIALS).
 *
 *   - flag off ⇒ 404 before any param is read or the service runs;
 *   - flag on ⇒ allow-list validation of kind / sort / tier / subtopic / cwid /
 *     limit / page / slug (400 with a static message, service never called);
 *   - unknown topic (service null) ⇒ 404; valid ⇒ 200 with a 1-indexed page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockGetTopicActivity, mockGetScholars } = vi.hoisted(() => ({
  mockGetTopicActivity: vi.fn(),
  mockGetScholars: vi.fn(),
}));

vi.mock("@/lib/api/topic-activity", () => ({
  getTopicActivity: mockGetTopicActivity,
  getTopicActivityScholars: mockGetScholars,
}));

import { GET } from "@/app/api/topics/[slug]/activity/route";

const SLUG = "cancer_genomics";
const call = (qs: string, slug = SLUG) =>
  GET(new NextRequest(new URL(`http://localhost/api/topics/${SLUG}/activity${qs}`)), {
    params: Promise.resolve({ slug }),
  });

const RESULT = {
  kind: "grant",
  hits: [],
  total: 0,
  counts: { grant: { strongly: 0, also: 0 }, trial: { strongly: 0, also: 0 } },
  tierTotals: { strongly: 0, also: 0 },
  displayThreshold: 0.5,
  subtopicApplied: false,
  page: 0,
  pageSize: 20,
};

beforeEach(() => {
  mockGetTopicActivity.mockReset();
  mockGetTopicActivity.mockResolvedValue(RESULT);
  mockGetScholars.mockReset();
  mockGetScholars.mockResolvedValue({ totals: {}, scholars: [], displayThreshold: 0.5 });
});
afterEach(() => vi.unstubAllEnvs());

describe("flag off", () => {
  it("is a 404 before any loader runs, even for a valid request", async () => {
    vi.stubEnv("TOPIC_FEED_GRANTS_TRIALS", "off");
    const res = await call("?kind=grant");
    expect(res.status).toBe(404);
    expect(mockGetTopicActivity).not.toHaveBeenCalled();
  });

  it("unset is off", async () => {
    vi.stubEnv("TOPIC_FEED_GRANTS_TRIALS", "");
    expect((await call("?kind=trial")).status).toBe(404);
    expect(mockGetTopicActivity).not.toHaveBeenCalled();
  });
});

describe("flag on", () => {
  beforeEach(() => vi.stubEnv("TOPIC_FEED_GRANTS_TRIALS", "on"));

  it.each([
    ["", "invalid kind"],
    ["?kind=publication", "invalid kind"],
    ["?kind=grant&sort=most_cited", "invalid sort"],
    ["?kind=grant&tier=all", "invalid tier"],
    ["?kind=grant&subtopic=Bad-Sub", "invalid subtopic"],
    ["?kind=grant&cwid=1abc", "invalid cwid"],
    ["?kind=grant&limit=25", "invalid limit"],
    ["?kind=grant&limit=220", "invalid limit"],
    ["?kind=grant&page=0", "invalid page"],
    ["?kind=grant&page=abc", "invalid page"],
  ])("%s → 400 %s", async (qs, error) => {
    const res = await call(qs);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(mockGetTopicActivity).not.toHaveBeenCalled();
  });

  it("rejects a path-traversal slug", async () => {
    const res = await call("?kind=grant", "../etc/passwd");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid topic slug");
  });

  it("404s an unknown topic", async () => {
    mockGetTopicActivity.mockResolvedValue(null);
    expect((await call("?kind=grant")).status).toBe(404);
  });

  it("passes validated params through with defaults and returns a 1-indexed page", async () => {
    const res = await call("?kind=trial");
    expect(res.status).toBe(200);
    expect(mockGetTopicActivity).toHaveBeenCalledWith(SLUG, {
      kind: "trial",
      sort: "newest",
      tier: undefined,
      subtopic: undefined,
      cwid: undefined,
      page: 0,
      pageSize: 20,
    });
    expect((await res.json()).page).toBe(1);
  });

  it("passes every param", async () => {
    await call("?kind=grant&sort=best_match&tier=also&subtopic=sub_a&cwid=abc1234&limit=40&page=2");
    expect(mockGetTopicActivity).toHaveBeenCalledWith(SLUG, {
      kind: "grant",
      sort: "best_match",
      tier: "also",
      subtopic: "sub_a",
      cwid: "abc1234",
      page: 1,
      pageSize: 40,
    });
  });

  it.each(["status", "ending"])("accepts sort=%s", async (sort) => {
    expect((await call(`?kind=trial&sort=${sort}`)).status).toBe(200);
    expect(mockGetTopicActivity.mock.calls[0][1].sort).toBe(sort);
  });

  it("kind=scholars reads only subtopic and calls the scholars service", async () => {
    const res = await call("?kind=scholars&subtopic=sub_a&sort=bogus");
    expect(res.status).toBe(200);
    expect(mockGetScholars).toHaveBeenCalledWith(SLUG, { subtopic: "sub_a" });
    expect(mockGetTopicActivity).not.toHaveBeenCalled();
    expect((await call("?kind=scholars&subtopic=Bad-Slug!")).status).toBe(400);
    mockGetScholars.mockResolvedValueOnce(null);
    expect((await call("?kind=scholars")).status).toBe(404);
  });
});
