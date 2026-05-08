/**
 * Smoke tests for app/api/topics/[slug]/publications/route.ts.
 *
 * Validates allowlist enforcement (threat model T-03-05-01 through T-03-05-06):
 *   - Invalid sort → 400
 *   - Invalid subtopic (non-slug chars) → 400
 *   - Invalid filter → 400
 *   - Topic slug with path-traversal chars → 400
 *   - Unknown topic (service returns null) → 404
 *   - Valid request → 200
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock the service layer so route tests do not hit the database.
const { mockGetTopicPublications } = vi.hoisted(() => ({
  mockGetTopicPublications: vi.fn(),
}));

vi.mock("@/lib/api/topics", () => ({
  getTopicPublications: mockGetTopicPublications,
}));

import { GET } from "@/app/api/topics/[slug]/publications/route";

function makeReq(url: string): NextRequest {
  return new NextRequest(new URL(url));
}

beforeEach(() => {
  mockGetTopicPublications.mockReset();
});

describe("/api/topics/[slug]/publications route", () => {
  it("rejects invalid sort with 400", async () => {
    const res = await GET(
      makeReq("http://localhost/api/topics/cancer_genomics/publications?sort=BAD"),
      { params: Promise.resolve({ slug: "cancer_genomics" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid sort");
    expect(mockGetTopicPublications).not.toHaveBeenCalled();
  });

  it("rejects subtopic with hyphen (only [a-z0-9_] allowed)", async () => {
    const res = await GET(
      makeReq("http://localhost/api/topics/cancer_genomics/publications?sort=newest&subtopic=BAD-with-hyphen"),
      { params: Promise.resolve({ slug: "cancer_genomics" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid subtopic");
    expect(mockGetTopicPublications).not.toHaveBeenCalled();
  });

  it("rejects invalid filter with 400", async () => {
    const res = await GET(
      makeReq("http://localhost/api/topics/cancer_genomics/publications?sort=newest&filter=DESTROY"),
      { params: Promise.resolve({ slug: "cancer_genomics" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid filter");
    expect(mockGetTopicPublications).not.toHaveBeenCalled();
  });

  it("rejects topic slug with slash injection", async () => {
    const res = await GET(
      makeReq("http://localhost/api/topics/x/publications?sort=newest"),
      { params: Promise.resolve({ slug: "../etc/passwd" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid topic slug");
    expect(mockGetTopicPublications).not.toHaveBeenCalled();
  });

  it("returns 404 when topic not found (service returns null)", async () => {
    mockGetTopicPublications.mockResolvedValue(null);
    const res = await GET(
      makeReq("http://localhost/api/topics/nonexistent/publications?sort=newest"),
      { params: Promise.resolve({ slug: "nonexistent" }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("topic not found");
  });

  it("returns 200 with paginated result on valid request", async () => {
    mockGetTopicPublications.mockResolvedValue({
      hits: [],
      total: 0,
      page: 0,
      pageSize: 20,
    });
    const res = await GET(
      makeReq("http://localhost/api/topics/cancer_genomics/publications?sort=newest"),
      { params: Promise.resolve({ slug: "cancer_genomics" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hits).toBeInstanceOf(Array);
    expect(body.pageSize).toBe(20);
    // URL 1-indexed: page=0 from service → page=1 in response
    expect(body.page).toBe(1);
  });

  it("accepts valid sort values: newest, most_cited, by_impact", async () => {
    mockGetTopicPublications.mockResolvedValue({ hits: [], total: 0, page: 0, pageSize: 20 });
    for (const sort of ["newest", "most_cited", "by_impact"]) {
      const res = await GET(
        makeReq(`http://localhost/api/topics/test_topic/publications?sort=${sort}`),
        { params: Promise.resolve({ slug: "test_topic" }) },
      );
      expect(res.status).toBe(200);
    }
  });

  it("accepts valid filter values: research_articles_only, all", async () => {
    mockGetTopicPublications.mockResolvedValue({ hits: [], total: 0, page: 0, pageSize: 20 });
    for (const filter of ["research_articles_only", "all"]) {
      const res = await GET(
        makeReq(`http://localhost/api/topics/test_topic/publications?sort=newest&filter=${filter}`),
        { params: Promise.resolve({ slug: "test_topic" }) },
      );
      expect(res.status).toBe(200);
    }
  });

  it("accepts valid subtopic slug [a-z0-9_]", async () => {
    mockGetTopicPublications.mockResolvedValue({ hits: [], total: 0, page: 0, pageSize: 20 });
    const res = await GET(
      makeReq("http://localhost/api/topics/cancer_genomics/publications?sort=newest&subtopic=breast_screening"),
      { params: Promise.resolve({ slug: "cancer_genomics" }) },
    );
    expect(res.status).toBe(200);
    expect(mockGetTopicPublications).toHaveBeenCalledWith(
      "cancer_genomics",
      expect.objectContaining({ subtopic: "breast_screening" }),
    );
  });

  it("rejects page=0 with 400 (URL page is 1-indexed; 0 is invalid)", async () => {
    const res = await GET(
      makeReq("http://localhost/api/topics/cancer_genomics/publications?sort=newest&page=0"),
      { params: Promise.resolve({ slug: "cancer_genomics" }) },
    );
    expect(res.status).toBe(400);
    expect(mockGetTopicPublications).not.toHaveBeenCalled();
  });

  it("clamps page to MAX_PAGE (500) to prevent DoS", async () => {
    mockGetTopicPublications.mockResolvedValue({ hits: [], total: 0, page: 499, pageSize: 20 });
    const res = await GET(
      makeReq("http://localhost/api/topics/cancer_genomics/publications?sort=newest&page=99999"),
      { params: Promise.resolve({ slug: "cancer_genomics" }) },
    );
    expect(res.status).toBe(200);
    // Service should have been called with page=499 (MAX_PAGE-1 = 500-1 = 499)
    expect(mockGetTopicPublications).toHaveBeenCalledWith(
      "cancer_genomics",
      expect.objectContaining({ page: 499 }),
    );
  });

  it("error responses do not echo back user input (T-03-05-06)", async () => {
    const maliciousSort = "' OR 1=1--";
    const res = await GET(
      makeReq(`http://localhost/api/topics/test/publications?sort=${encodeURIComponent(maliciousSort)}`),
      { params: Promise.resolve({ slug: "test" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("OR 1=1");
    expect(serialized).not.toContain(maliciousSort);
  });
});
