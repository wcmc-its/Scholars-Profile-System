/**
 * RED unit tests for app/sitemap.ts (Phase 5 / SEO-01).
 *
 * These tests define the contract that Plan 02 must satisfy. They FAIL now
 * because app/sitemap.ts does not yet exist. That is the expected RED state.
 *
 * Contract:
 *   - Default export is an async function returning MetadataRoute.Sitemap
 *   - Module exports `revalidate = 86400` (ISR fallback cadence)
 *   - Includes home `/` with priority 1.0 and changeFrequency 'weekly'
 *   - Includes active scholar URLs with priority 0.8 / changeFrequency 'weekly'
 *   - Includes topic URLs with priority 0.6 / changeFrequency 'monthly'
 *   - Includes department URLs with priority 0.6 / changeFrequency 'monthly'
 *   - Includes static pages /browse, /about, /about/methodology with priority 0.5 / changeFrequency 'monthly'
 *   - Excludes /search
 *   - Excludes deleted scholars (those not returned by the active-filter query)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockScholarFindMany,
  mockTopicFindMany,
  mockDepartmentFindMany,
} = vi.hoisted(() => ({
  mockScholarFindMany: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockDepartmentFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findMany: mockScholarFindMany },
    topic: { findMany: mockTopicFindMany },
    department: { findMany: mockDepartmentFindMany },
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  process.env.NEXT_PUBLIC_SITE_URL = "https://scholars.weill.cornell.edu";
});

describe("app/sitemap.ts — revalidate export", () => {
  it("exports revalidate = 86400", async () => {
    // Will fail with module-not-found until Plan 02 creates app/sitemap.ts
    const mod = await import("@/app/sitemap");
    expect((mod as Record<string, unknown>).revalidate).toBe(86400);
  });
});

describe("app/sitemap.ts — default sitemap function", () => {
  beforeEach(() => {
    // Active scholars: jane-doe (active), deleted-bob (simulated active
    // — deleted scholars are excluded by the Prisma query's WHERE filter,
    // so the mock only returns rows that pass deletedAt: null AND status: 'active').
    mockScholarFindMany.mockResolvedValue([
      {
        slug: "jane-doe",
        updatedAt: new Date("2026-04-01T00:00:00Z"),
      },
      // NOTE: deleted-bob is NOT returned here because the query filters it
      // out via WHERE deletedAt IS NULL AND status = 'active'. The mock
      // deliberately reflects the query result, not the raw table contents.
    ]);
    mockTopicFindMany.mockResolvedValue([
      { id: "cardiovascular_disease", refreshedAt: new Date("2026-04-01T00:00:00Z") },
    ]);
    mockDepartmentFindMany.mockResolvedValue([
      { slug: "medicine", updatedAt: new Date("2026-04-01T00:00:00Z") },
    ]);
  });

  it("returns an array of sitemap entries", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = await sitemap();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("includes home / with priority 1.0 and changeFrequency weekly", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = await sitemap();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/",
        priority: 1.0,
        changeFrequency: "weekly",
      }),
    );
  });

  it("includes active scholar with priority 0.8 and changeFrequency weekly", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = await sitemap();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/scholars/jane-doe",
        priority: 0.8,
        changeFrequency: "weekly",
      }),
    );
  });

  it("includes topic with priority 0.6 and changeFrequency monthly", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = await sitemap();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/topics/cardiovascular_disease",
        priority: 0.6,
        changeFrequency: "monthly",
      }),
    );
  });

  it("includes department with priority 0.6 and changeFrequency monthly", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = await sitemap();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/departments/medicine",
        priority: 0.6,
        changeFrequency: "monthly",
      }),
    );
  });

  it("includes /browse with priority 0.5 and changeFrequency monthly", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = await sitemap();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/browse",
        priority: 0.5,
        changeFrequency: "monthly",
      }),
    );
  });

  it("includes /about with priority 0.5 and changeFrequency monthly", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = await sitemap();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/about",
        priority: 0.5,
        changeFrequency: "monthly",
      }),
    );
  });

  it("includes /about/methodology with priority 0.5 and changeFrequency monthly", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = await sitemap();
    expect(entries).toContainEqual(
      expect.objectContaining({
        url: "https://scholars.weill.cornell.edu/about/methodology",
        priority: 0.5,
        changeFrequency: "monthly",
      }),
    );
  });

  it("excludes /search — search page carries noindex and must not appear in sitemap", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = await sitemap();
    expect(entries.find((e: { url: string }) => e.url.endsWith("/search"))).toBeUndefined();
  });

  it("excludes deleted scholars — query WHERE filter prevents deleted rows from returning", async () => {
    // The mock simulates only the active query result (no deleted-bob row).
    // This test verifies the sitemap does not introduce its own deleted-bob entry
    // from a second unfiltered query or any other source.
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = await sitemap();
    expect(entries.find((e: { url: string }) => e.url.endsWith("/scholars/deleted-bob"))).toBeUndefined();
  });
});
