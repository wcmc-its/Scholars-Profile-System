/**
 * #2240 — a story stored under a slug the feed no longer emits (a 301 alias)
 * is never matched by url, and the #2241 story dedup skips the canonical
 * create. The stored row must still get its article metadata refreshed, and
 * only its metadata: a human hide/reject on it survives.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const newsMention = { findMany: h.findMany, create: h.create, update: h.update };
  return {
    db: {
      write: {
        newsMention,
        $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn({ newsMention })),
      },
    },
  };
});

import { upsertMentions } from "@/etl/news/index";

const ORIGIN = "https://news.weill.cornell.edu";
const ALIAS = `${ORIGIN}/news/2024/04/april-awards-honors`;
const CANON = `${ORIGIN}/news/2024/04/awards-honors-april`;
const DAY = new Date("2024-04-30T00:00:00Z");

const stored = {
  id: "nm-1",
  cwid: "dcl2001",
  url: ALIAS,
  title: "April: Awards & Honors",
  publishedAt: DAY,
  excerpt: "Dr. Someone Else, associate professor of ...",
  thumbnailUrl: null,
  outlet: null,
  creditedOutlet: null,
};

const feedRow = {
  cwid: "dcl2001",
  url: CANON,
  title: "Awards & Honors: April",
  publishedAt: DAY,
  excerpt: "Awards, honors and achievements for the month of April.",
  thumbnailUrl: null,
  status: "published" as const,
  source: "VIVO" as const,
  detectedName: null,
  likelihood: null,
  matchBasis: null,
  sourceRef: null,
  contextSnippet: null,
  outlet: null,
  creditedOutlet: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // 1st findMany: by url (the alias row is not under CANON). 2nd: by cwid.
  h.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([stored]);
});

describe("upsertMentions — stale sibling under another slug (#2240)", () => {
  it("refreshes the stored row's metadata instead of silently skipping it", async () => {
    const res = await upsertMentions([feedRow]);

    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledTimes(1);
    const { where, data } = h.update.mock.calls[0][0];
    expect(where).toEqual({ id: "nm-1" });
    expect(data).toEqual({
      title: "Awards & Honors: April",
      excerpt: "Awards, honors and achievements for the month of April.",
    });
    // Review state and identity are never touched on the sibling.
    for (const k of ["status", "source", "showOnProfile", "enteredByCwid", "url"]) {
      expect(data).not.toHaveProperty(k);
    }
    expect(res).toMatchObject({ inserted: 0, updated: 1, deduped: 1 });
  });
});
