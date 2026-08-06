/**
 * The upsert-preserve discipline (etl/news/index.ts) — the load-bearing
 * divergence from scholar_technology, which truncate-rebuilds. A re-scrape must
 * never revert a human's approve/reject/hide or resurrect a rejected row. Pure
 * `reconcile` + `articlesToMentions`, no DB.
 */
import { describe, expect, it } from "vitest";

import {
  articlesToMentions,
  assertNoLegacyOriginRows,
  reconcile,
  type ExistingMention,
} from "@/etl/news/index";
import { storyKey, type ScrapedArticle } from "@/etl/news/seed";

const ORIGIN = "https://news.weill.cornell.edu";
const URL = `${ORIGIN}/news/2026/07/some-article`;

const existing = (over: Partial<ExistingMention>): ExistingMention => ({
  status: "pending",
  source: "NAME",
  enteredByCwid: null,
  title: "Old title",
  publishedAt: new Date("2026-07-16T00:00:00Z"),
  excerpt: "old",
  thumbnailUrl: null,
  detectedName: "Jane Roe",
  likelihood: "HIGH",
  sourceRef: `${URL}|jane roe`,
  ...over,
});

const incomingName = {
  cwid: "jro1",
  url: URL,
  title: "Old title",
  publishedAt: new Date("2026-07-16T00:00:00Z"),
  excerpt: "old",
  thumbnailUrl: null,
  status: "pending" as const,
  source: "NAME" as const,
  detectedName: "Jane Roe",
  likelihood: "HIGH",
  sourceRef: `${URL}|jane roe`,
};

describe("reconcile — review state", () => {
  it("preserves a human-REJECTED row unchanged when the same name re-scrapes", () => {
    const patch = reconcile(existing({ status: "rejected", enteredByCwid: "curator1" }), incomingName);
    expect(patch).toEqual({}); // no status/source churn, nothing to update
  });

  it("preserves a human-APPROVED (published) row; a later NAME re-scrape can't demote it", () => {
    const patch = reconcile(
      existing({ status: "published", source: "NAME", enteredByCwid: "curator1" }),
      incomingName,
    );
    expect(patch).toEqual({});
  });

  it("does NOT resurrect an ETL-owned REJECTED row even when VIVO now links it", () => {
    const patch = reconcile(
      existing({ status: "rejected", source: "NAME", enteredByCwid: null }),
      { ...incomingName, source: "VIVO", status: "published", detectedName: null, likelihood: null, sourceRef: null },
    );
    expect(patch).toEqual({});
  });

  it("upgrades an ETL-owned pending NAME row to VIVO when the article gains the link", () => {
    const patch = reconcile(existing({ status: "pending", source: "NAME", enteredByCwid: null }), {
      ...incomingName,
      source: "VIVO",
      status: "published",
      detectedName: null,
      likelihood: null,
      sourceRef: null,
    });
    expect(patch).toMatchObject({ source: "VIVO", status: "published", detectedName: null, sourceRef: null });
  });

  it("never downgrades an existing VIVO row when only a NAME match arrives", () => {
    const patch = reconcile(existing({ status: "published", source: "VIVO", enteredByCwid: null }), incomingName);
    expect(patch.status).toBeUndefined();
    expect(patch.source).toBeUndefined();
  });

  it("always refreshes changed article metadata, even on a human-touched row", () => {
    const patch = reconcile(
      existing({ status: "published", enteredByCwid: "curator1", title: "Old title" }),
      { ...incomingName, title: "New title" },
    );
    expect(patch).toEqual({ title: "New title" });
  });
});

describe("articlesToMentions", () => {
  const scholars = [
    { cwid: "xim2002", fullName: "Xiaojing Ma", preferredName: "Xiaojing Ma", primaryTitle: null, primaryDepartment: null },
    { cwid: "jro1", fullName: "Jane Roe", preferredName: "Jane Roe", primaryTitle: null, primaryDepartment: null },
  ];
  const article: ScrapedArticle = {
    url: URL,
    title: "A study",
    excerpt: null,
    thumbnailUrl: null,
    publishedAt: "2026-07-16",
    cwids: ["xim2002"], // VIVO-linked
    bodyText: "Work by Xiaojing Ma with collaborator Jane Roe.",
  };

  it("makes a published VIVO row + a pending NAME row, never both for one scholar", () => {
    const rows = articlesToMentions([article], scholars);
    const byCwid = Object.fromEntries(rows.map((r) => [r.cwid, r]));
    expect(byCwid.xim2002).toMatchObject({ status: "published", source: "VIVO" });
    expect(byCwid.jro1).toMatchObject({ status: "pending", source: "NAME", detectedName: "Jane Roe" });
    expect(rows.length).toBe(2);
  });

  it("drops a VIVO cwid with no scholar row", () => {
    const rows = articlesToMentions([{ ...article, cwids: ["ghost99"] }], scholars);
    // ghost99 has no scholar row -> no VIVO row; Jane Roe still name-matched.
    expect(rows.find((r) => r.cwid === "ghost99")).toBeUndefined();
    expect(rows.find((r) => r.cwid === "jro1")).toBeTruthy();
  });
});

describe("storyKey (#2241 — one story, two slugs)", () => {
  const D = new Date("2024-04-30T00:00:00Z");

  it("collapses the real prod pair: word-order variants on the same date", () => {
    // /april-awards-honors vs /awards-honors-april — same date, same excerpt,
    // same body, two urls. A plain normalized title would NOT match these.
    expect(storyKey("April: Awards & Honors", D)).toBe(storyKey("Awards & Honors: April", D));
  });

  it("ignores punctuation, case and runs of whitespace", () => {
    // Titles reach the DB already entity-decoded by the scraper's clean(), so
    // this only has to be robust to real punctuation, not to "&amp;".
    expect(storyKey("Awards & Honors: April", D)).toBe(storyKey("awards   honors,  april", D));
  });

  it("does NOT collapse different stories on the same date", () => {
    expect(storyKey("A New Kind of Cold Sensor", D)).not.toBe(
      storyKey("Nerves in Skin Can Slow Melanoma Growth", D),
    );
  });

  it("does NOT collapse the same title on different dates", () => {
    expect(storyKey("Awards & Honors: April", D)).not.toBe(
      storyKey("Awards & Honors: April", new Date("2025-04-30T00:00:00Z")),
    );
  });

  it("returns null without a date — one weak signal must not merge two stories", () => {
    expect(storyKey("Awards & Honors: April", null)).toBeNull();
  });

  it("returns null for a title with no word characters", () => {
    expect(storyKey("—", D)).toBeNull();
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(storyKey("Awards & Honors: April", "2024-04-30")).toBe(
      storyKey("Awards & Honors: April", D),
    );
  });
});

describe("articlesToMentions — story dedup (#2241)", () => {
  const scholars = [
    {
      cwid: "dcl2001",
      fullName: "David Lyden",
      preferredName: "David Lyden",
      primaryTitle: null,
      primaryDepartment: null,
    },
  ];
  const art = (slug: string, title: string): ScrapedArticle => ({
    url: `https://news.weill.cornell.edu/news/2024/04/${slug}`,
    title,
    excerpt: "Dr. Eloise Chapman-Davis, associate...",
    thumbnailUrl: null,
    publishedAt: "2024-04-30",
    cwids: ["dcl2001"],
    bodyText: "Dr. David Lyden, the Stavros S. Niarchos Professor...",
  });

  it("emits ONE row when the feed carries the story under two slugs", () => {
    const rows = articlesToMentions(
      [art("april-awards-honors", "April: Awards & Honors"), art("awards-honors-april", "Awards & Honors: April")],
      scholars,
    );
    expect(rows).toHaveLength(1);
  });

  it("still emits both when the two articles are genuinely different stories", () => {
    const rows = articlesToMentions(
      [art("a-cold-sensor", "A New Kind of Cold Sensor"), art("melanoma", "Nerves in Skin Slow Melanoma")],
      scholars,
    );
    expect(rows).toHaveLength(2);
  });

  it("falls back to the url when an article has no date, keeping both", () => {
    const rows = articlesToMentions(
      [
        { ...art("a", "April: Awards & Honors"), publishedAt: null },
        { ...art("b", "Awards & Honors: April"), publishedAt: null },
      ],
      scholars,
    );
    expect(rows).toHaveLength(2);
  });
});

describe("assertNoLegacyOriginRows (#2200 source-repoint interlock)", () => {
  it("passes on a table with no rows under a previous origin", async () => {
    await expect(assertNoLegacyOriginRows(async () => 0)).resolves.toBeUndefined();
  });

  it("refuses to run while pre-repoint rows survive", async () => {
    // Running would re-key every article, reverting scholar hides and reviewer
    // rejections — a runbook line cannot gate a scheduled state machine.
    await expect(assertNoLegacyOriginRows(async () => 1_595)).rejects.toThrow(
      /1595 news_mention row\(s\) predate the current source origin/,
    );
  });
});
