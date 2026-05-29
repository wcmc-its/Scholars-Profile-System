/**
 * Unit tests for the sitemap-index split (#124, B25) — Phase 5 / SEO-01.
 *
 * Covers the shared model/serialization in `lib/sitemap.ts` and the two Route
 * Handlers (`app/sitemap.xml/route.ts` index, `app/sitemap/[shard]/route.ts`
 * children).
 *
 * Contract:
 *   - `/sitemap.xml` serves a `<sitemapindex>` referencing one `/sitemap/[id].xml`
 *     child per URLS_PER_SITEMAP-sized shard of the corpus
 *   - each child serves a `<urlset>` slice; an out-of-range shard is empty, a
 *     non-`.xml` segment 404s
 *   - entries include all active scholars, topics, departments, centers, and
 *     static pages; exclude /search and soft-deleted scholars
 *   - priority / changeFrequency per D-08:
 *       Home 1.0/weekly · Scholars 0.8/weekly · Topics/depts/centers 0.6/monthly
 *       · Static (browse, about) 0.5/monthly
 *
 * Mocks: @/lib/db prisma; no real DB connections.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  URLS_PER_SITEMAP,
  sitemapChunkCount,
  buildSitemapEntries,
  renderUrlset,
  renderSitemapIndex,
  parseShardId,
  siteBaseUrl,
  type SitemapEntry,
} from "@/lib/sitemap";

const { mockScholarFindMany, mockTopicFindMany, mockDeptFindMany, mockCenterFindMany } = vi.hoisted(
  () => ({
    mockScholarFindMany: vi.fn(),
    mockTopicFindMany: vi.fn(),
    mockDeptFindMany: vi.fn(),
    mockCenterFindMany: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findMany: mockScholarFindMany },
    topic: { findMany: mockTopicFindMany },
    department: { findMany: mockDeptFindMany },
    center: { findMany: mockCenterFindMany },
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  process.env.NEXT_PUBLIC_SITE_URL = "https://scholars.weill.cornell.edu";

  mockScholarFindMany.mockResolvedValue([
    { slug: "jane-doe", updatedAt: new Date("2026-01-15") },
    { slug: "john-smith", updatedAt: new Date("2026-02-10") },
  ]);
  mockTopicFindMany.mockResolvedValue([
    { id: "cancer_genomics", refreshedAt: new Date("2026-03-01") },
    { id: "infectious_disease", refreshedAt: new Date("2026-03-02") },
  ]);
  mockDeptFindMany.mockResolvedValue([
    { slug: "medicine", updatedAt: new Date("2026-02-01") },
    { slug: "pediatrics", updatedAt: new Date("2026-02-02") },
  ]);
  mockCenterFindMany.mockResolvedValue([]);
});

// Routes imported after the db mock is registered.
import { GET as sitemapIndexGET } from "@/app/sitemap.xml/route";
import { GET as sitemapChildGET } from "@/app/sitemap/[shard]/route";

const childParams = (shard: string) => ({ params: Promise.resolve({ shard }) });

describe("lib/sitemap — chunk helper", () => {
  it("never returns fewer than one shard (well-formed empty index)", () => {
    expect(sitemapChunkCount(0)).toBe(1);
  });

  it("keeps a sub-cap corpus in a single shard", () => {
    expect(sitemapChunkCount(1)).toBe(1);
    expect(sitemapChunkCount(URLS_PER_SITEMAP)).toBe(1);
  });

  it("splits once the corpus exceeds the shard size", () => {
    expect(sitemapChunkCount(URLS_PER_SITEMAP + 1)).toBe(2);
    expect(sitemapChunkCount(URLS_PER_SITEMAP * 3)).toBe(3);
    expect(sitemapChunkCount(URLS_PER_SITEMAP * 3 + 1)).toBe(4);
  });

  it("shard size stays at or under the 50k-URL protocol cap", () => {
    expect(URLS_PER_SITEMAP).toBeLessThanOrEqual(50_000);
  });
});

describe("lib/sitemap — parseShardId", () => {
  it("parses canonical child segments", () => {
    expect(parseShardId("0.xml")).toBe(0);
    expect(parseShardId("12.xml")).toBe(12);
  });

  it("rejects segments without the .xml suffix or with non-numeric ids", () => {
    expect(parseShardId("0")).toBeNull();
    expect(parseShardId("abc.xml")).toBeNull();
    expect(parseShardId("1.html")).toBeNull();
    expect(parseShardId("-1.xml")).toBeNull();
    expect(parseShardId("")).toBeNull();
  });
});

describe("lib/sitemap — siteBaseUrl", () => {
  it("uses NEXT_PUBLIC_SITE_URL when set", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://custom.example.com";
    expect(siteBaseUrl()).toBe("https://custom.example.com");
  });

  it("falls back to the default domain when unset", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(siteBaseUrl()).toBe("https://scholars.weill.cornell.edu");
  });
});

describe("lib/sitemap — buildSitemapEntries", () => {
  it("includes home / with priority 1.0 weekly and the other static pages", async () => {
    const entries = await buildSitemapEntries();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/",
        priority: 1.0,
        changeFrequency: "weekly",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ url: "https://scholars.weill.cornell.edu/browse", priority: 0.5 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ url: "https://scholars.weill.cornell.edu/about", priority: 0.5 }),
    );
  });

  it("excludes /search and /about/methodology", async () => {
    const entries = await buildSitemapEntries();
    expect(entries.find((e) => e.url.endsWith("/search"))).toBeUndefined();
    expect(entries.find((e) => e.url.endsWith("/about/methodology"))).toBeUndefined();
  });

  it("emits one scholar entry (0.8/weekly) per active scholar, lastmod from updatedAt", async () => {
    const entries = await buildSitemapEntries();
    const jane = entries.find((e) => e.url.endsWith("/scholars/jane-doe"));
    expect(jane).toMatchObject({ priority: 0.8, changeFrequency: "weekly" });
    expect(jane?.lastModified).toEqual(new Date("2026-01-15"));
  });

  it("queries scholars with deletedAt: null and status: active", async () => {
    await buildSitemapEntries();
    expect(mockScholarFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null, status: "active" }),
      }),
    );
  });

  it("emits topics, departments, and centers at 0.6/monthly", async () => {
    mockCenterFindMany.mockResolvedValue([{ slug: "meyer", updatedAt: new Date("2026-04-01") }]);
    const entries = await buildSitemapEntries();
    expect(entries).toContainEqual(
      expect.objectContaining({ url: "https://scholars.weill.cornell.edu/topics/cancer_genomics", priority: 0.6, changeFrequency: "monthly" }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ url: "https://scholars.weill.cornell.edu/departments/medicine", priority: 0.6 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ url: "https://scholars.weill.cornell.edu/centers/meyer", priority: 0.6 }),
    );
  });

  it("orders static entries first, so home is always in shard 0", async () => {
    const entries = await buildSitemapEntries();
    expect(entries[0].url).toBe("https://scholars.weill.cornell.edu/");
  });

  it("fails soft to static-only entries when the DB is unreachable", async () => {
    mockScholarFindMany.mockRejectedValue(new Error("no DB"));
    const entries = await buildSitemapEntries();
    expect(entries).toHaveLength(3); // /, /browse, /about
    expect(entries.every((e) => !e.url.includes("/scholars/"))).toBe(true);
  });
});

describe("lib/sitemap — renderUrlset", () => {
  const entry: SitemapEntry = {
    url: "https://scholars.weill.cornell.edu/scholars/jane-doe",
    lastModified: new Date("2026-01-15T00:00:00.000Z"),
    changeFrequency: "weekly",
    priority: 0.8,
  };

  it("wraps entries in a urlset with loc/lastmod/changefreq/priority", () => {
    const xml = renderUrlset([entry]);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<loc>https://scholars.weill.cornell.edu/scholars/jane-doe</loc>");
    expect(xml).toContain("<lastmod>2026-01-15T00:00:00.000Z</lastmod>");
    expect(xml).toContain("<changefreq>weekly</changefreq>");
    expect(xml).toContain("<priority>0.8</priority>");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("renders priority 1.0 as 1 (no trailing zeros)", () => {
    const xml = renderUrlset([{ ...entry, priority: 1.0 }]);
    expect(xml).toContain("<priority>1</priority>");
  });

  it("XML-escapes special characters in the loc", () => {
    const xml = renderUrlset([{ ...entry, url: "https://x.test/a?b=1&c=2" }]);
    expect(xml).toContain("<loc>https://x.test/a?b=1&amp;c=2</loc>");
    expect(xml).not.toContain("c=2&c"); // no raw ampersand
  });

  it("produces a valid empty urlset for no entries", () => {
    const xml = renderUrlset([]);
    expect(xml).toContain("<urlset");
    expect(xml).toContain("</urlset>");
    expect(xml).not.toContain("<url>");
  });
});

describe("lib/sitemap — renderSitemapIndex", () => {
  it("lists one <sitemap> per shard pointing at /sitemap/{id}.xml", () => {
    const xml = renderSitemapIndex(3, "https://scholars.weill.cornell.edu");
    expect(xml).toContain("<sitemapindex");
    expect(xml).toContain("<loc>https://scholars.weill.cornell.edu/sitemap/0.xml</loc>");
    expect(xml).toContain("<loc>https://scholars.weill.cornell.edu/sitemap/1.xml</loc>");
    expect(xml).toContain("<loc>https://scholars.weill.cornell.edu/sitemap/2.xml</loc>");
    expect((xml.match(/<sitemap>/g) ?? []).length).toBe(3);
  });
});

describe("app/sitemap.xml — index route", () => {
  it("returns a sitemapindex with application/xml and one shard for a sub-cap corpus", async () => {
    const res = await sitemapIndexGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/xml");
    const body = await res.text();
    expect(body).toContain("<sitemapindex");
    expect(body).toContain("<loc>https://scholars.weill.cornell.edu/sitemap/0.xml</loc>");
    expect((body.match(/<sitemap>/g) ?? []).length).toBe(1);
  });
});

describe("app/sitemap/[shard] — child route", () => {
  it("serves shard 0 as a urlset of the corpus slice", async () => {
    const res = await sitemapChildGET(new Request("http://x/sitemap/0.xml"), childParams("0.xml"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/xml");
    const body = await res.text();
    expect(body).toContain("<urlset");
    // 2 scholars + 2 topics + 2 depts + 0 centers + 3 static = 9 urls.
    expect((body.match(/<url>/g) ?? []).length).toBe(9);
    expect(body).toContain("<loc>https://scholars.weill.cornell.edu/scholars/jane-doe</loc>");
  });

  it("returns an empty urlset for an out-of-range shard", async () => {
    const res = await sitemapChildGET(new Request("http://x/sitemap/9.xml"), childParams("9.xml"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<urlset");
    expect(body).not.toContain("<url>");
  });

  it("404s a non-canonical segment", async () => {
    const res = await sitemapChildGET(new Request("http://x/sitemap/abc"), childParams("abc"));
    expect(res.status).toBe(404);
  });
});
