/**
 * Feed parsing + incremental walk (etl/news/scrape.ts), against fixture JSON
 * shaped like news.weill.cornell.edu/news/feed.json. No network: scrapeNews
 * takes an injected fetcher.
 */
import { describe, expect, it } from "vitest";

import { feedStories, parseCwids, parseDate, scrapeNews } from "@/etl/news/scrape";

const ORIGIN = "https://news.weill.cornell.edu";

const story = (opts: {
  slug: string;
  title?: string;
  date?: string;
  body?: string;
  teaser?: string;
  image?: string | null;
  path?: string;
}) => ({
  story: {
    uuid: opts.slug,
    title: opts.title ?? "Title One",
    path: opts.path ?? `${ORIGIN}/news/2026/07/${opts.slug}`,
    field_story_post_date: opts.date ?? "July 16, 2026",
    field_story_body: opts.body ?? "<p>Body text.</p>",
    field_story_teaser: opts.teaser ?? "Excerpt one.",
    field_story_featured_image:
      opts.image === null
        ? null
        : { src: opts.image ?? `${ORIGIN}/sites/default/files/x.jpg?itok=a&amp;c=b`, alt: "alt" },
    field_story_type: "News from WCM",
    term_node_tid: "Cardiology, Dr. Someone",
  },
});

const feed = (stories: ReturnType<typeof story>[]) => JSON.stringify({ news_stories: stories });

describe("feedStories", () => {
  it("maps a story to url, title, excerpt, same-origin thumbnail, ISO date", () => {
    const [a] = feedStories(feed([story({ slug: "a-b-c" })]));
    expect(a).toEqual({
      url: `${ORIGIN}/news/2026/07/a-b-c`,
      title: "Title One",
      excerpt: "Excerpt one.",
      // The `&amp;` cache-buster is decoded, and the src is kept because it is same-origin.
      thumbnailUrl: `${ORIGIN}/sites/default/files/x.jpg?itok=a&c=b`,
      publishedAt: "2026-07-16",
      cwids: [],
      bodyText: "Body text.",
    });
  });

  it("extracts VIVO cwids from the body HTML and strips it to prose", () => {
    const [a] = feedStories(
      feed([
        story({
          slug: "d-e-f",
          body: `<p>Findings by <a href="https://vivo.weill.cornell.edu/display/cwid-XiM2002">Dr. Xiaojing Ma</a> and <a href="https://vivo.med.cornell.edu/display/cwid-gal2005">Dr. Gang Lin</a>.</p>`,
        }),
      ]),
    );
    expect([...a.cwids].sort()).toEqual(["gal2005", "xim2002"]);
    expect(a.bodyText).toContain("Dr. Xiaojing Ma");
    expect(a.bodyText).not.toContain("<a href");
  });

  it("drops off-origin and untitled stories rather than throwing", () => {
    const rows = feedStories(
      feed([
        story({ slug: "ok" }),
        story({ slug: "evil", path: "https://evil.example.com/news/2026/07/evil" }),
        story({ slug: "blank", title: "" }),
      ]),
    );
    expect(rows.map((r) => r.url)).toEqual([`${ORIGIN}/news/2026/07/ok`]);
  });

  it("throws when the payload is not a feed", () => {
    expect(() => feedStories(JSON.stringify({ nope: [] }))).toThrow(/news_stories/);
  });

  it("nulls an unparseable date rather than failing the story", () => {
    const [a] = feedStories(feed([story({ slug: "x", date: "sometime" })]));
    expect(a.publishedAt).toBeNull();
  });
});

describe("parseDate / parseCwids", () => {
  it("parses the feed's date format at UTC midnight", () => {
    expect(parseDate("August 5, 2026")).toBe("2026-08-05");
  });
  it("lowercases and dedupes cwids", () => {
    expect(parseCwids("cwid-ABC123 cwid-abc123 cwid-def").sort()).toEqual(["abc123", "def"]);
  });
  it("drops malformed cwids so one upstream typo cannot fail the whole run", () => {
    // 1 char is too short and 33 is too long for seed.ts's CWID_RE; the live
    // path validates, so these must never reach validateArticles.
    expect(parseCwids(`cwid-x cwid-${"a".repeat(33)} cwid-ok4001`)).toEqual(["ok4001"]);
  });
});

describe("scrapeNews (incremental)", () => {
  const page0 = feed([story({ slug: "new-1" }), story({ slug: "known-2" })]);
  const page1 = feed([story({ slug: "known-3" })]);
  const empty = feed([]);
  const fetcher = (byPage: Record<string, string | null>) => async (url: string) => {
    const m = url.match(/page=(\d+)/);
    return byPage[m ? m[1] : "0"] ?? null;
  };
  const u = (slug: string) => `${ORIGIN}/news/2026/07/${slug}`;

  it("stops once a page contributes nothing new", async () => {
    const known = new Set([u("known-2"), u("known-3")]);
    const got = await scrapeNews(known, { get: fetcher({ "0": page0, "1": page1 }) });
    // page0 has one new article; page1 is all-known so the walk stops before it.
    expect(got.map((a) => a.url)).toEqual([u("new-1")]);
  });

  it("backfill (empty known set) walks to the end of the feed", async () => {
    const got = await scrapeNews(new Set(), {
      get: fetcher({ "0": page0, "1": page1, "2": empty }),
    });
    expect(got.map((a) => a.url).sort()).toEqual([u("known-2"), u("known-3"), u("new-1")]);
  });

  it("throws rather than truncating when a page mid-walk is unreadable", async () => {
    await expect(
      scrapeNews(new Set(), { get: fetcher({ "0": page0, "1": null }) }),
    ).rejects.toThrow(/refusing a truncated crawl/);
  });

  it("throws when the feed itself is unavailable", async () => {
    await expect(scrapeNews(new Set(), { get: fetcher({ "0": null }) })).rejects.toThrow(
      /feed unavailable/,
    );
  });

  it("throws when page 0 is empty — a feed collapse, not an empty corpus", async () => {
    await expect(scrapeNews(new Set(), { get: fetcher({ "0": empty }) })).rejects.toThrow(
      /0 stories/,
    );
  });
});
