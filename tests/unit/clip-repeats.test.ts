/** Media Highlights repeat detection (`lib/edit/clip-repeats.ts`) and the clip
 *  link normalization in `unwrapLink`. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import {
  dropHeadlineRepeats,
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

describe("dropHeadlineRepeats", () => {
  it("drops the same headline under another url within 14 days, keeping the earliest", () => {
    const early = clip({ url: "https://kff.example/s", publishedAt: "2026-09-18" });
    const late = clip({ url: "https://yahoo.example/s", publishedAt: "2026-09-22" });
    const { kept, dropped } = dropHeadlineRepeats([late, early], []);
    expect(kept).toEqual([early]);
    expect(dropped).toBe(1);
  });

  it("drops a repeat of a STORED clip; keeps an exact-url re-read (the upsert's update path)", () => {
    const stored = clip({ url: "https://kff.example/s", publishedAt: "2026-09-18" });
    const again = clip({ url: "https://kff.example/s", publishedAt: "2026-09-18" });
    const copy = clip({ url: "https://yahoo.example/s", publishedAt: "2026-09-25" });
    const { kept, dropped } = dropHeadlineRepeats([again, copy], [stored]);
    expect(kept).toEqual([again]);
    expect(dropped).toBe(1);
  });

  it("keeps: another scholar, a different headline, more than 14 days apart, or no date", () => {
    const base = clip({ url: "https://kff.example/s" });
    const rows = [
      clip({ url: "https://b.example/1", cwid: "zzz9999" }),
      clip({ url: "https://b.example/2", title: "A different story entirely" }),
      clip({ url: "https://b.example/3", publishedAt: "2026-10-20" }),
      { ...clip({ url: "https://b.example/4" }), publishedAt: null },
    ];
    expect(dropHeadlineRepeats(rows, [base]).dropped).toBe(0);
  });
});

describe("findPossibleRepeat", () => {
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
