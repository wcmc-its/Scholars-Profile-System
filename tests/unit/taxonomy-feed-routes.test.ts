/**
 * Phase 4 (TAXONOMY_FEED_LOAD_MORE) — the publication routes' `limit` param and
 * the category-wide "All families" route.
 *
 *   - `limit` (topic + family routes): flag on ⇒ digits only, a whole number of
 *     20-row chunks, at most 200, else 400 with a static message before any
 *     loader runs; a valid value reaches the loader as `pageSize`. Flag off ⇒
 *     ignored (no `pageSize` forwarded), even when malformed.
 *   - `/api/methods/[sc]/all/publications`: 404 while the flag is off; strict
 *     validation of slug / sort / filter / page / limit; an unknown or
 *     all-suppressed category is a 404; the loader gets the resolved id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getTopicPublications: vi.fn(),
  getFamily: vi.fn(),
  getFamilyPublications: vi.fn(),
  getSupercategory: vi.fn(),
  getSupercategoryPublications: vi.fn(),
}));

vi.mock("@/lib/api/topics", () => ({ getTopicPublications: h.getTopicPublications }));
vi.mock("@/lib/api/methods", () => ({
  getFamily: h.getFamily,
  getFamilyPublications: h.getFamilyPublications,
  getSupercategory: h.getSupercategory,
  getSupercategoryPublications: h.getSupercategoryPublications,
}));

import { GET as topicGET } from "@/app/api/topics/[slug]/publications/route";
import { GET as familyGET } from "@/app/api/methods/[supercategory]/[family]/publications/route";
import { GET as categoryGET } from "@/app/api/methods/[supercategory]/all/publications/route";

const topicReq = (qs: string) =>
  topicGET(new NextRequest(new URL(`http://localhost/api/topics/cardio/publications?${qs}`)), {
    params: Promise.resolve({ slug: "cardio" }),
  });
const familyReq = (qs: string) =>
  familyGET(
    new NextRequest(new URL(`http://localhost/api/methods/imaging/mri-fam_0001/publications?${qs}`)),
    { params: Promise.resolve({ supercategory: "imaging", family: "mri-fam_0001" }) },
  );
const categoryReq = (qs: string, slug = "imaging") =>
  categoryGET(new NextRequest(new URL(`http://localhost/api/methods/${slug}/all/publications?${qs}`)), {
    params: Promise.resolve({ supercategory: slug }),
  });

const BAD_LIMITS = ["0", "10", "25", "220", "400", "-20", "20.0", "2e1", "abc", "", " 40", "0040x", "99999"];

beforeEach(() => {
  vi.clearAllMocks();
  h.getTopicPublications.mockResolvedValue({ hits: [], total: 0, page: 0, pageSize: 20 });
  h.getFamily.mockResolvedValue({ supercategory: "imaging_x", familyLabel: "MRI" });
  h.getFamilyPublications.mockResolvedValue({ hits: [], total: 0, page: 0, pageSize: 20 });
  h.getSupercategory.mockResolvedValue({ id: "imaging_x", slug: "imaging", label: "Imaging" });
  h.getSupercategoryPublications.mockResolvedValue({
    hits: [],
    total: 0,
    totalAllTypes: 0,
    totalResearchOnly: 0,
    page: 0,
    pageSize: 20,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("limit on the topic and family routes", () => {
  describe("flag on", () => {
    beforeEach(() => vi.stubEnv("TAXONOMY_FEED_LOAD_MORE", "on"));

    it.each(BAD_LIMITS)("topic route rejects limit %j with 400", async (bad) => {
      const res = await topicReq(`sort=newest&limit=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid limit");
      expect(h.getTopicPublications).not.toHaveBeenCalled();
    });

    it.each(BAD_LIMITS)("family route rejects limit %j with 400", async (bad) => {
      const res = await familyReq(`sort=newest&limit=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid limit");
      expect(h.getFamily).not.toHaveBeenCalled();
      expect(h.getFamilyPublications).not.toHaveBeenCalled();
    });

    it("forwards a valid limit as pageSize (topic)", async () => {
      await topicReq("sort=newest&page=1&limit=60");
      expect(h.getTopicPublications).toHaveBeenCalledWith(
        "cardio",
        expect.objectContaining({ page: 0, pageSize: 60 }),
      );
    });

    it("forwards a valid limit as pageSize (family), 200 is the ceiling", async () => {
      await familyReq("sort=newest&page=1&limit=200");
      expect(h.getFamilyPublications).toHaveBeenCalledWith(
        "imaging_x",
        "MRI",
        expect.objectContaining({ page: 0, pageSize: 200 }),
      );
    });

    it("no limit (or the default 20) forwards no pageSize", async () => {
      await topicReq("sort=newest&page=3");
      await topicReq("sort=newest&page=3&limit=20");
      for (const call of h.getTopicPublications.mock.calls) {
        expect(call[1]).not.toHaveProperty("pageSize");
        expect(call[1].page).toBe(2);
      }
    });
  });

  describe("flag off", () => {
    it("ignores even a malformed limit (pre-flag behavior)", async () => {
      const t = await topicReq("sort=newest&limit=abc");
      const f = await familyReq("sort=newest&limit=9999");
      expect(t.status).toBe(200);
      expect(f.status).toBe(200);
      expect(h.getTopicPublications.mock.calls[0][1]).not.toHaveProperty("pageSize");
      expect(h.getFamilyPublications.mock.calls[0][2]).not.toHaveProperty("pageSize");
    });
  });
});

describe("GET /api/methods/[sc]/all/publications", () => {
  it("is a 404 while TAXONOMY_FEED_LOAD_MORE is off, before any loader runs", async () => {
    const res = await categoryReq("sort=newest");
    expect(res.status).toBe(404);
    expect(h.getSupercategory).not.toHaveBeenCalled();
    expect(h.getSupercategoryPublications).not.toHaveBeenCalled();
  });

  describe("flag on", () => {
    beforeEach(() => vi.stubEnv("TAXONOMY_FEED_LOAD_MORE", "on"));

    it("resolves the slug and forwards validated params (page 1-indexed out, 0-indexed in)", async () => {
      h.getSupercategoryPublications.mockResolvedValue({
        hits: [{ pmid: "1", familyLabel: "MRI" }],
        total: 41,
        totalAllTypes: 50,
        totalResearchOnly: 41,
        page: 2,
        pageSize: 20,
      });
      const res = await categoryReq("sort=most_cited&filter=all&page=3");
      expect(res.status).toBe(200);
      expect(h.getSupercategory).toHaveBeenCalledWith("imaging");
      expect(h.getSupercategoryPublications).toHaveBeenCalledWith("imaging_x", {
        sort: "most_cited",
        filter: "all",
        page: 2,
        pageSize: 20,
      });
      const body = await res.json();
      expect(body.page).toBe(3);
      expect(body.hits[0].familyLabel).toBe("MRI");
    });

    it("defaults: newest, research articles only, page 1, 20 rows", async () => {
      await categoryReq("");
      expect(h.getSupercategoryPublications).toHaveBeenCalledWith("imaging_x", {
        sort: "newest",
        filter: "research_articles_only",
        page: 0,
        pageSize: 20,
      });
    });

    it("a ?shown restore arrives as one bounded request", async () => {
      await categoryReq("page=1&limit=120");
      expect(h.getSupercategoryPublications.mock.calls[0][1]).toMatchObject({ page: 0, pageSize: 120 });
    });

    it.each([
      ["sort=relevance", "invalid sort"],
      ["sort=newest;drop", "invalid sort"],
      ["filter=everything", "invalid filter"],
      ["page=0", "invalid page"],
      ["page=-1", "invalid page"],
      ["page=1.5", "invalid page"],
      ["page=abc", "invalid page"],
      ["limit=30", "invalid limit"],
      ["limit=400", "invalid limit"],
    ])("rejects %s with 400 (%s), no loader call", async (qs, msg) => {
      const res = await categoryReq(qs);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(msg);
      expect(h.getSupercategory).not.toHaveBeenCalled();
      expect(h.getSupercategoryPublications).not.toHaveBeenCalled();
    });

    it.each(["Imaging", "../etc", "imaging_x", "-imaging", "im aging"])(
      "rejects the slug %j with 400",
      async (slug) => {
        const res = await categoryReq("sort=newest", slug);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe("invalid supercategory");
      },
    );

    it("clamps a huge page to MAX_PAGE", async () => {
      await categoryReq("page=999999");
      expect(h.getSupercategoryPublications.mock.calls[0][1].page).toBe(499);
    });

    it("bounds the offset, not just the page, for a 200-row limit", async () => {
      await categoryReq("page=999999&limit=200");
      const call = h.getSupercategoryPublications.mock.calls[0][1];
      expect(call.pageSize).toBe(200);
      expect(call.page).toBe(49);
    });

    it("an unknown or all-suppressed category is a 404", async () => {
      h.getSupercategory.mockResolvedValue(null);
      const res = await categoryReq("sort=newest");
      expect(res.status).toBe(404);
      expect(h.getSupercategoryPublications).not.toHaveBeenCalled();
    });

    it("lens off (loader null) is a 404", async () => {
      h.getSupercategoryPublications.mockResolvedValue(null);
      const res = await categoryReq("sort=newest");
      expect(res.status).toBe(404);
    });
  });
});
