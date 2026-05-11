/**
 * RED unit tests for app/sitemap.ts — Phase 5 / SEO-01.
 *
 * Contract:
 *   - Default export is async function returning MetadataRoute.Sitemap array
 *   - Module exports `revalidate = 86400` (ISR fallback)
 *   - Includes all active scholars, topics, departments, and static pages
 *   - Excludes /search and soft-deleted scholars
 *   - Priority / changeFrequency per D-08:
 *       Home: 1.0 / weekly
 *       Scholars: 0.8 / weekly
 *       Topics / depts: 0.6 / monthly
 *       Static (browse, about, about/methodology): 0.5 / monthly
 *
 * Mocks: @/lib/db prisma; no real DB connections.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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

import * as mod from "@/app/sitemap";

describe("app/sitemap — module exports", () => {
  it("exports revalidate = 86400 (ISR fallback per D-07)", () => {
    expect(mod.revalidate).toBe(86400);
  });

  it("default export is a function", () => {
    expect(typeof mod.default).toBe("function");
  });
});

describe("app/sitemap — static pages", () => {
  it("includes home / with priority 1.0 and changeFrequency weekly", async () => {
    const entries = await mod.default();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/",
        priority: 1.0,
        changeFrequency: "weekly",
      }),
    );
  });

  it("includes /browse with priority 0.5 and changeFrequency monthly", async () => {
    const entries = await mod.default();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/browse",
        priority: 0.5,
        changeFrequency: "monthly",
      }),
    );
  });

  it("includes /about with priority 0.5 and changeFrequency monthly", async () => {
    const entries = await mod.default();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/about",
        priority: 0.5,
        changeFrequency: "monthly",
      }),
    );
  });

  it("includes /about/methodology with priority 0.5 and changeFrequency monthly", async () => {
    const entries = await mod.default();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/about/methodology",
        priority: 0.5,
        changeFrequency: "monthly",
      }),
    );
  });

  it("does NOT include /search (noindex page excluded from sitemap)", async () => {
    const entries = await mod.default();
    expect(entries.find((e) => e.url.endsWith("/search"))).toBeUndefined();
  });
});

describe("app/sitemap — scholar entries", () => {
  it("includes one entry per active scholar with priority 0.8 and changeFrequency weekly", async () => {
    const entries = await mod.default();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/scholars/jane-doe",
        priority: 0.8,
        changeFrequency: "weekly",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/scholars/john-smith",
        priority: 0.8,
        changeFrequency: "weekly",
      }),
    );
  });

  it("queries scholars with deletedAt: null and status: active filter", async () => {
    await mod.default();
    expect(mockScholarFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null, status: "active" }),
      }),
    );
  });

  it("uses lastModified from scholar.updatedAt", async () => {
    const entries = await mod.default();
    const janeEntry = entries.find((e) =>
      e.url.endsWith("/scholars/jane-doe"),
    );
    expect(janeEntry?.lastModified).toEqual(new Date("2026-01-15"));
  });
});

describe("app/sitemap — topic entries", () => {
  it("includes one entry per topic with priority 0.6 and changeFrequency monthly", async () => {
    const entries = await mod.default();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/topics/cancer_genomics",
        priority: 0.6,
        changeFrequency: "monthly",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/topics/infectious_disease",
        priority: 0.6,
        changeFrequency: "monthly",
      }),
    );
  });
});

describe("app/sitemap — department entries", () => {
  it("includes one entry per department with priority 0.6 and changeFrequency monthly", async () => {
    const entries = await mod.default();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/departments/medicine",
        priority: 0.6,
        changeFrequency: "monthly",
      }),
    );
  });
});

describe("app/sitemap — NEXT_PUBLIC_SITE_URL fallback", () => {
  it("uses NEXT_PUBLIC_SITE_URL env var for URL prefix", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://custom.example.com";
    const entries = await mod.default();
    expect(entries.some((e) => e.url.startsWith("https://custom.example.com"))).toBe(true);
  });

  it("falls back to default domain when NEXT_PUBLIC_SITE_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const entries = await mod.default();
    expect(entries.some((e) => e.url.startsWith("https://scholars.weill.cornell.edu"))).toBe(true);
  });
});
