/**
 * `lib/api/slug-registry.ts` — the slug-namespace registry reads for
 * `/edit/slugs` (#497). Covers each segment's query shape + pagination, the
 * dead-end flag on history rows, the dormant-table tolerance of the `requested`
 * segment, and every `resolveSlugStatus` verdict (reserved / invalid / live /
 * override / history / available).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  loadSlugRegistry,
  resolveSlugStatus,
  type SlugRegistryClient,
  type SlugStatusClient,
} from "@/lib/api/slug-registry";

type AnyMock = ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

// ── shared fakes ───────────────────────────────────────────────────────────

function client(over: Record<string, Record<string, AnyMock>> = {}): SlugRegistryClient {
  const base = {
    scholar: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) },
    slugHistory: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), findUnique: vi.fn().mockResolvedValue(null) },
    fieldOverride: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) },
    slugRequest: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  };
  for (const [model, fns] of Object.entries(over)) {
    Object.assign((base as Record<string, Record<string, AnyMock>>)[model], fns);
  }
  return base as unknown as SlugRegistryClient;
}

// ── segment: active ─────────────────────────────────────────────────────────

describe("loadSlugRegistry — active", () => {
  it("queries live, non-deleted scholars ordered by slug, take/skip default 50/0", async () => {
    const c = client({
      scholar: {
        findMany: vi.fn().mockResolvedValue([
          { slug: "jane-smith", cwid: "js1", preferredName: "Jane Smith", fullName: "Jane Q. Smith" },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });
    const { rows, total } = await loadSlugRegistry({ segment: "active" }, c);
    const args = (c.scholar.findMany as AnyMock).mock.calls[0][0];
    expect(args.where).toMatchObject({ deletedAt: null, status: "active" });
    expect(args.orderBy).toEqual([{ slug: "asc" }]);
    expect(args.take).toBe(50);
    expect(args.skip).toBe(0);
    expect(total).toBe(1);
    expect(rows[0]).toEqual({ slug: "jane-smith", cwid: "js1", name: "Jane Smith" });
  });

  it("a query ORs slug/name/CWID and is trimmed + lowercased", async () => {
    const c = client();
    await loadSlugRegistry({ segment: "active", query: "  SMITH " }, c);
    const where = (c.scholar.findMany as AnyMock).mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { slug: { contains: "smith" } },
      { preferredName: { contains: "smith" } },
      { fullName: { contains: "smith" } },
      { cwid: { contains: "smith" } },
    ]);
    // count uses the same where as findMany.
    expect((c.scholar.count as AnyMock).mock.calls[0][0].where).toEqual(where);
  });

  it("falls back name: preferredName → fullName → null", async () => {
    const c = client({
      scholar: {
        findMany: vi.fn().mockResolvedValue([
          { slug: "a", cwid: "1", preferredName: null, fullName: "Full Name" },
          { slug: "b", cwid: "2", preferredName: null, fullName: null },
        ]),
      },
    });
    const { rows } = await loadSlugRegistry({ segment: "active" }, c);
    const active = rows as Array<{ name: string | null }>;
    expect(active[0].name).toBe("Full Name");
    expect(active[1].name).toBeNull();
  });

  it("caps take at 200 and floors skip at 0", async () => {
    const c = client();
    await loadSlugRegistry({ segment: "active", limit: 9999, offset: -5 }, c);
    const args = (c.scholar.findMany as AnyMock).mock.calls[0][0];
    expect(args.take).toBe(200);
    expect(args.skip).toBe(0);
  });
});

// ── segment: collisions (-N) ────────────────────────────────────────────────

describe("loadSlugRegistry — collisions", () => {
  it("narrows to hyphenated slugs in SQL then keeps only `-N` suffixes in memory", async () => {
    const c = client({
      scholar: {
        findMany: vi.fn().mockResolvedValue([
          { slug: "jane-smith", cwid: "1", preferredName: "Jane", fullName: null }, // not -N
          { slug: "jane-smith-2", cwid: "2", preferredName: "Jane 2", fullName: null }, // -N
          { slug: "x-3", cwid: "3", preferredName: "X", fullName: null }, // -N
        ]),
      },
    });
    const { rows, total } = await loadSlugRegistry({ segment: "collisions" }, c);
    const where = (c.scholar.findMany as AnyMock).mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ slug: { contains: "-" } });
    expect(total).toBe(2);
    expect(rows.map((r) => (r as { slug: string }).slug)).toEqual(["jane-smith-2", "x-3"]);
  });

  it("paginates the in-memory matched set", async () => {
    const c = client({
      scholar: {
        findMany: vi.fn().mockResolvedValue(
          Array.from({ length: 5 }, (_, i) => ({
            slug: `s-${i + 2}`,
            cwid: `c${i}`,
            preferredName: `N${i}`,
            fullName: null,
          })),
        ),
      },
    });
    const { rows, total } = await loadSlugRegistry({ segment: "collisions", limit: 2, offset: 2 }, c);
    expect(total).toBe(5);
    expect(rows.map((r) => (r as { slug: string }).slug)).toEqual(["s-4", "s-5"]);
  });

  it("ANDs the search term with the hyphen filter", async () => {
    const c = client();
    await loadSlugRegistry({ segment: "collisions", query: "jane" }, c);
    const and = (c.scholar.findMany as AnyMock).mock.calls[0][0].where.AND;
    expect(and[0]).toEqual({ slug: { contains: "-" } });
    expect(and[1].OR).toContainEqual({ slug: { contains: "jane" } });
  });
});

// ── segment: historical ─────────────────────────────────────────────────────

describe("loadSlugRegistry — historical", () => {
  it("queries slug_history newest-first and flags redirect vs dead-end", async () => {
    const c = client({
      slugHistory: {
        findMany: vi.fn().mockResolvedValue([
          {
            oldSlug: "old-live",
            currentCwid: "c1",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            current: { slug: "new-live", preferredName: "Live One", fullName: null, deletedAt: null, status: "active" },
          },
          {
            oldSlug: "old-dead",
            currentCwid: "c2",
            createdAt: new Date("2025-01-01T00:00:00Z"),
            current: { slug: "gone", preferredName: "Gone", fullName: null, deletedAt: new Date(), status: "active" },
          },
          {
            oldSlug: "old-suppressed",
            currentCwid: "c3",
            createdAt: new Date("2024-01-01T00:00:00Z"),
            current: { slug: "hidden", preferredName: "Hidden", fullName: null, deletedAt: null, status: "suppressed" },
          },
        ]),
        count: vi.fn().mockResolvedValue(3),
      },
    });
    const { rows, total } = await loadSlugRegistry({ segment: "historical" }, c);
    expect((c.slugHistory.findMany as AnyMock).mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
    expect(total).toBe(3);
    expect(rows[0]).toMatchObject({ oldSlug: "old-live", currentSlug: "new-live", redirects: true });
    expect(rows[1]).toMatchObject({ oldSlug: "old-dead", redirects: false }); // soft-deleted
    expect(rows[2]).toMatchObject({ oldSlug: "old-suppressed", redirects: false }); // suppressed
  });

  it("a query ORs oldSlug + currentCwid", async () => {
    const c = client();
    await loadSlugRegistry({ segment: "historical", query: "Smith" }, c);
    const where = (c.slugHistory.findMany as AnyMock).mock.calls[0][0].where;
    expect(where.OR).toEqual([{ oldSlug: { contains: "smith" } }, { currentCwid: { contains: "smith" } }]);
  });
});

// ── segment: override ───────────────────────────────────────────────────────

describe("loadSlugRegistry — override", () => {
  it("queries FieldOverride(scholar, slug) and maps holder + actor + updated", async () => {
    const c = client({
      fieldOverride: {
        findMany: vi.fn().mockResolvedValue([
          { value: "pinned", entityId: "holder1", actorCwid: "admin9", updatedAt: new Date("2026-02-02T00:00:00Z") },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });
    const { rows } = await loadSlugRegistry({ segment: "override" }, c);
    const where = (c.fieldOverride.findMany as AnyMock).mock.calls[0][0].where;
    expect(where).toMatchObject({ entityType: "scholar", fieldName: "slug" });
    expect(rows[0]).toEqual({
      slug: "pinned",
      pinnedForCwid: "holder1",
      setByCwid: "admin9",
      updatedAt: "2026-02-02T00:00:00.000Z",
    });
  });

  it("a query ORs value + entityId", async () => {
    const c = client();
    await loadSlugRegistry({ segment: "override", query: "x" }, c);
    const where = (c.fieldOverride.findMany as AnyMock).mock.calls[0][0].where;
    expect(where.OR).toEqual([{ value: { contains: "x" } }, { entityId: { contains: "x" } }]);
  });
});

// ── segment: reserved (no DB) ───────────────────────────────────────────────

describe("loadSlugRegistry — reserved", () => {
  it("returns reserved words from the in-memory set, sorted, no DB query", async () => {
    const c = client();
    const { rows, total } = await loadSlugRegistry({ segment: "reserved" }, c);
    expect(total).toBeGreaterThan(0);
    expect((rows as Array<{ word: string }>).map((r) => r.word)).toContain("about");
    // sorted
    const words = (rows as Array<{ word: string }>).map((r) => r.word);
    expect([...words].sort()).toEqual(words);
    // no DB read
    expect((c.scholar.findMany as AnyMock)).not.toHaveBeenCalled();
    expect((c.fieldOverride.findMany as AnyMock)).not.toHaveBeenCalled();
  });

  it("filters the reserved set by the search term", async () => {
    const c = client();
    const { rows } = await loadSlugRegistry({ segment: "reserved", query: "about" }, c);
    expect((rows as Array<{ word: string }>).every((r) => r.word.includes("about"))).toBe(true);
    expect((rows as Array<{ word: string }>).map((r) => r.word)).toContain("about");
  });
});

// ── segment: requested ──────────────────────────────────────────────────────

describe("loadSlugRegistry — requested", () => {
  it("queries ALL statuses newest-first (not pending-only) and maps decision fields", async () => {
    const c = client({
      slugRequest: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "r1",
            requestedSlug: "want-this",
            cwid: "c1",
            status: "rejected",
            requestedBy: "c1",
            createdAt: new Date("2026-03-03T00:00:00Z"),
            decidedBy: "admin1",
            decidedAt: new Date("2026-03-04T00:00:00Z"),
            decisionNote: "namesake collision",
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });
    const { rows, total } = await loadSlugRegistry({ segment: "requested" }, c);
    const args = (c.slugRequest.findMany as AnyMock).mock.calls[0][0];
    // no status filter — all statuses
    expect(args.where.status).toBeUndefined();
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    expect(total).toBe(1);
    expect(rows[0]).toEqual({
      id: "r1",
      requestedSlug: "want-this",
      forCwid: "c1",
      status: "rejected",
      requestedByCwid: "c1",
      requestedAt: "2026-03-03T00:00:00.000Z",
      decidedByCwid: "admin1",
      decidedAt: "2026-03-04T00:00:00.000Z",
      decisionNote: "namesake collision",
    });
  });

  it("tolerates a dormant/absent slug_request table — returns an empty page, no throw", async () => {
    const c = client({
      slugRequest: {
        findMany: vi.fn().mockRejectedValue(new Error("Table 'scholars.slug_request' doesn't exist")),
        count: vi.fn().mockRejectedValue(new Error("Table 'scholars.slug_request' doesn't exist")),
      },
    });
    const { rows, total } = await loadSlugRegistry({ segment: "requested" }, c);
    expect(rows).toEqual([]);
    expect(total).toBe(0);
  });
});

// ── resolveSlugStatus ───────────────────────────────────────────────────────

function statusClient(over: Record<string, Record<string, AnyMock>> = {}): SlugStatusClient {
  const base = {
    scholar: { findFirst: vi.fn().mockResolvedValue(null) },
    fieldOverride: { findFirst: vi.fn().mockResolvedValue(null) },
    slugHistory: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
  };
  for (const [model, fns] of Object.entries(over)) {
    Object.assign((base as Record<string, Record<string, AnyMock>>)[model], fns);
  }
  return base as unknown as SlugStatusClient;
}

describe("resolveSlugStatus", () => {
  it("a reserved route word → reserved (no DB lookup)", async () => {
    const c = statusClient();
    const status = await resolveSlugStatus("about", c);
    expect(status).toEqual({ state: "reserved", slug: "about" });
    expect((c.scholar.findFirst as AnyMock)).not.toHaveBeenCalled();
  });

  it("a malformed slug → invalid (format)", async () => {
    const status = await resolveSlugStatus("Not A Slug!", statusClient());
    expect(status).toEqual({ state: "invalid", reason: "format" });
  });

  it("an over-long slug → invalid (too_long)", async () => {
    const status = await resolveSlugStatus("a".repeat(65), statusClient());
    expect(status).toEqual({ state: "invalid", reason: "too_long" });
  });

  it("held by a live scholar → taken/live with name + cwid", async () => {
    const c = statusClient({
      scholar: { findFirst: vi.fn().mockResolvedValue({ cwid: "js1", preferredName: "Jane Smith", fullName: "Jane Q. Smith" }) },
    });
    const status = await resolveSlugStatus("jane-smith", c);
    expect(status).toEqual({ state: "taken", slug: "jane-smith", held: "live", cwid: "js1", name: "Jane Smith" });
  });

  it("pinned by another override → taken/override with the holder cwid", async () => {
    const c = statusClient({
      // checkSlugCollision: live findFirst null, override findFirst hits.
      fieldOverride: { findFirst: vi.fn().mockResolvedValue({ id: "o1", entityId: "holder7" }) },
    });
    const status = await resolveSlugStatus("pinned-slug", c);
    expect(status).toMatchObject({ state: "taken", held: "override", cwid: "holder7" });
  });

  it("a former slug of a different scholar → taken/history (claiming breaks the 301)", async () => {
    const c = statusClient({
      slugHistory: {
        // checkSlugCollision uses findFirst (collision); the holder-resolution uses findUnique.
        findFirst: vi.fn().mockResolvedValue({ oldSlug: "old-slug" }),
        findUnique: vi.fn().mockResolvedValue({ currentCwid: "c9", current: { slug: "new-slug" } }),
      },
    });
    const status = await resolveSlugStatus("old-slug", c);
    expect(status).toMatchObject({ state: "taken", held: "history", currentCwid: "c9", currentSlug: "new-slug" });
  });

  it("free across all sources → available (normalized value)", async () => {
    const status = await resolveSlugStatus("  Brand-New  ", statusClient());
    expect(status).toEqual({ state: "available", slug: "brand-new" });
  });

  it("a benign race (collision reported but no source matches) → available", async () => {
    // checkSlugCollision sees a live hit, but the holder-resolution finds none
    // (the holder vanished between reads) → treat as available.
    const c = statusClient({
      scholar: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ cwid: "ghost" }) // checkSlugCollision's live probe
          .mockResolvedValueOnce(null), // holder-resolution probe
      },
    });
    const status = await resolveSlugStatus("racey", c);
    expect(status).toEqual({ state: "available", slug: "racey" });
  });
});
