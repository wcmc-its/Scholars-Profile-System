/** A Media highlights clip never publishes its digest bullet as an excerpt. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import { toClipRow } from "@/lib/api/profile";

describe("toClipRow", () => {
  it("keeps headline, link, outlet and date; drops the excerpt", () => {
    expect(
      toClipRow({
        url: "https://example.org/story",
        title: "A headline",
        publishedAt: new Date("2026-09-22T00:00:00Z"),
        excerpt: "Dr. Jane Doe",
        thumbnailUrl: null,
        outlet: "IEEE Spectrum",
      }),
    ).toEqual({
      url: "https://example.org/story",
      title: "A headline",
      publishedAt: "2026-09-22",
      excerpt: null,
      thumbnailUrl: null,
      outlet: "IEEE Spectrum",
    });
  });
});
