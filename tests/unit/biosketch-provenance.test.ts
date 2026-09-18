/**
 * #917 v7 — `coerceEntries` backward-compat shim (`lib/edit/biosketch-provenance.ts`). This is the
 * one thing that lets a pre-v7 history row (persisted as a plain `string[]`) keep rendering after
 * entries became `{ title, body }[]`, so it is pinned directly: a legacy string row becomes a
 * title-less entry, a new `{title, body}` object is carried through, and junk is dropped.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGenerationFindMany, mockAuthorFindMany } = vi.hoisted(() => ({
  mockGenerationFindMany: vi.fn(),
  mockAuthorFindMany: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      biosketchGeneration: { findMany: mockGenerationFindMany },
      publicationAuthor: { findMany: mockAuthorFindMany },
    },
  },
}));

import { coerceEntries, listBiosketchGenerations } from "@/lib/edit/biosketch-provenance";

describe("coerceEntries — v7 backward-compat", () => {
  it("coerces a legacy string[] row to title-less entries", () => {
    expect(coerceEntries(["First.", "Second."])).toEqual([
      { title: "", body: "First." },
      { title: "", body: "Second." },
    ]);
  });

  it("carries a new { title, body }[] row through unchanged", () => {
    expect(coerceEntries([{ title: "Subject", body: "Paragraph." }])).toEqual([
      { title: "Subject", body: "Paragraph." },
    ]);
  });

  it("defaults a missing / non-string title to ''", () => {
    expect(coerceEntries([{ body: "B" }, { title: 5, body: "C" }])).toEqual([
      { title: "", body: "B" },
      { title: "", body: "C" },
    ]);
  });

  it("drops malformed members (no string body, non-objects) and non-array values", () => {
    expect(coerceEntries([{ title: "x" }, 7, null, "ok"])).toEqual([{ title: "", body: "ok" }]);
    expect(coerceEntries(null)).toEqual([]);
    expect(coerceEntries("nope")).toEqual([]);
    expect(coerceEntries(undefined)).toEqual([]);
  });
});

/** A stored run at `createdAt` (newest-first order is the caller's job, as in the real query). */
function row(id: string, createdAt: string) {
  return {
    id,
    mode: "contributions",
    entries: [{ title: "", body: "B." }],
    projectTitle: null,
    projectAims: null,
    model: "m",
    promptVersion: "v7",
    params: {},
    products: null,
    sources: null,
    createdByCwid: "abc1001",
    impersonatedCwid: null,
    label: null,
    createdAt: new Date(createdAt),
  };
}

describe("listBiosketchGenerations — staleness nudge (#2654)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts CONFIRMED authorships stamped after each draft, from ONE read keyed on the oldest", async () => {
    mockGenerationFindMany.mockResolvedValue([
      row("newer", "2026-07-20T00:00:00.000Z"),
      row("older", "2026-07-10T00:00:00.000Z"),
    ]);
    mockAuthorFindMany.mockResolvedValue([
      { lastRefreshedAt: new Date("2026-07-12T00:00:00.000Z") }, // after older only
      { lastRefreshedAt: new Date("2026-07-25T00:00:00.000Z") }, // after both
      { lastRefreshedAt: new Date("2026-07-20T00:00:00.000Z") }, // == newer: not "after"
    ]);
    const out = await listBiosketchGenerations("abc1001");

    expect(out.map((g) => [g.id, g.pubsAddedSince])).toEqual([
      ["newer", 1],
      ["older", 3],
    ]);
    expect(mockAuthorFindMany).toHaveBeenCalledTimes(1);
    expect(mockAuthorFindMany.mock.calls[0][0]).toEqual({
      where: {
        cwid: "abc1001",
        isConfirmed: true,
        lastRefreshedAt: { gt: new Date("2026-07-10T00:00:00.000Z") },
      },
      select: { lastRefreshedAt: true },
    });
  });

  it("reads no authorships when the scholar has no drafts", async () => {
    mockGenerationFindMany.mockResolvedValue([]);
    expect(await listBiosketchGenerations("abc1001")).toEqual([]);
    expect(mockAuthorFindMany).not.toHaveBeenCalled();
  });

  it("carries the label through (null when unlabeled)", async () => {
    mockGenerationFindMany.mockResolvedValue([
      { ...row("a", "2026-07-20T00:00:00.000Z"), label: "R01 resubmission" },
      row("b", "2026-07-10T00:00:00.000Z"),
    ]);
    mockAuthorFindMany.mockResolvedValue([]);
    const out = await listBiosketchGenerations("abc1001");
    expect(out.map((g) => g.label)).toEqual(["R01 resubmission", null]);
    expect(out.map((g) => g.pubsAddedSince)).toEqual([0, 0]);
  });
});
