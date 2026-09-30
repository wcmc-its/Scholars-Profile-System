/** Media highlights repeat detection (`lib/edit/clip-repeats.ts`) and the clip
 *  link normalization in `unwrapLink`. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import {
  findPossibleRepeat,
  headlineKey,
  headlinesSimilar,
} from "@/lib/edit/clip-repeats";
import { normalizeClipUrl, unwrapLink } from "@/etl/news/clips";

const clip = (over: Partial<{ id: string; cwid: string; url: string; title: string; publishedAt: string }>) => ({
  id: "x",
  cwid: "abc1234",
  url: "https://a.example/story",
  title: "Chronic Stress Increases Fat Storage In Muscle",
  publishedAt: "2026-09-22",
  ...over,
});

describe("normalizeClipUrl", () => {
  it("drops tracking params and the fragment; keeps real params and the path as given", () => {
    expect(normalizeClipUrl("https://News.Example.com/a/b/?utm_source=x&id=7&fbclid=y#top")).toBe(
      "https://news.example.com/a/b/?id=7",
    );
    expect(normalizeClipUrl("https://example.com/a?utm_medium=email")).toBe("https://example.com/a");
  });

  it("is clips-only: the shared unwrapLink keeps fragments for the funding digest", () => {
    expect(unwrapLink("https://portal.example.org/#/opportunity/9")).toBe("https://portal.example.org/#/opportunity/9");
  });
});

describe("headlineKey / headlinesSimilar", () => {
  it("ignores case, punctuation and word order", () => {
    expect(headlineKey("Stress: Fat Storage, in MUSCLE")).toBe(headlineKey("in muscle fat storage stress"));
  });

  it("flags a retitled copy but not two different stories on one topic", () => {
    expect(
      headlinesSimilar(
        "Chronic Stress Increases Fat Storage In Muscle",
        "Chronic stress drives fat storage in muscle, study finds",
      ),
    ).toBe(true);
    expect(
      headlinesSimilar("Life-Saving Questions For Lung Cancer Patients", "New Drug Approved For Lung Cancer"),
    ).toBe(false);
  });
});

describe("findPossibleRepeat", () => {
  it("flags an identical syndicated headline; never a generic column name", () => {
    const a = clip({ id: "a", title: "Her Son Was Dying, But His Rare Cancer Made It Difficult", url: "https://cbs.example/s" });
    const b = clip({ id: "b", title: "Her son was dying, but his rare cancer made it difficult", url: "https://yahoo.example/s" });
    expect(findPossibleRepeat(b, [a, b])?.id).toBe("a");
    const g1 = clip({ id: "g1", title: "At A Glance", url: "https://crains.example/1" });
    const g2 = clip({ id: "g2", title: "At A Glance", url: "https://crains.example/2" });
    expect(findPossibleRepeat(g2, [g1, g2])).toBeNull();
  });

  it("finds a similar headline for the same scholar within 7 days, never itself", () => {
    const row = clip({ id: "1" });
    const peers = [
      row,
      clip({ id: "2", cwid: "zzz9999", title: "Chronic stress drives fat storage in muscle" }),
      clip({ id: "3", title: "Chronic stress drives fat storage in muscle", publishedAt: "2026-10-05" }),
      clip({ id: "4", title: "Chronic stress drives fat storage in muscle", publishedAt: "2026-09-24" }),
    ];
    expect(findPossibleRepeat(row, peers)?.id).toBe("4");
    expect(findPossibleRepeat(row, [row])).toBeNull();
  });
});
