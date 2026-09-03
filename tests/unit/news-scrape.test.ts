/**
 * Feed parsing + incremental walk (etl/news/scrape.ts), against fixture JSON
 * shaped like news.weill.cornell.edu/news/feed.json. No network: scrapeNews
 * takes an injected fetcher.
 */
import { describe, expect, it } from "vitest";

import {
  feedStories,
  parseCaptions,
  parseCwids,
  parseDate,
  parseTags,
  scrapeNews,
} from "@/etl/news/scrape";
import { validateArticles } from "@/etl/news/seed";

const ORIGIN = "https://news.weill.cornell.edu";

const story = (opts: {
  slug: string;
  title?: string;
  date?: string;
  body?: string;
  teaser?: string;
  image?: string | null;
  path?: string;
  tags?: string;
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
    term_node_tid: opts.tags ?? "Cardiology, Dr. Someone",
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
      // #2578 — the feed's own tags and the photo alt text, both of which the
      // scraper used to parse and drop.
      tags: ["Cardiology", "Dr. Someone"],
      captionText: "alt",
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

describe("parseTags (#2578 — the feed's own story tags)", () => {
  it("comma-splits, trims, decodes entities and drops empties", () => {
    // The live feed publishes "Awards &amp; Honors" and pads inconsistently.
    expect(parseTags("Dr. Scott Tagawa,  Patient Care ,, Awards &amp; Honors,")).toEqual([
      "Dr. Scott Tagawa",
      "Patient Care",
      "Awards & Honors",
    ]);
  });

  it("does not classify person vs department — it returns everything", () => {
    // Person tags are NOT reliably `Dr. `-prefixed (students are tagged bare),
    // so any up-front split would be guesswork. names.ts intersects against the
    // roster instead, and a tag that resolves to nobody matches nothing.
    expect(parseTags("Cassandra Stecker, Dr. Leonard Girardi, Education")).toEqual([
      "Cassandra Stecker",
      "Dr. Leonard Girardi",
      "Education",
    ]);
  });

  it("dedupes and returns [] for a missing or blank field", () => {
    expect(parseTags("Research, Research")).toEqual(["Research"]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(42)).toEqual([]);
  });
});

describe("parseCaptions (#2578 — photo alt text)", () => {
  it("joins the featured-image alt with every body <img alt>", () => {
    // There is no <figcaption> anywhere in this feed: a captioned photo is a
    // nested <div class="caption"> whose person name lives in the img's alt.
    expect(
      parseCaptions(
        '<p>Body.</p><div class="caption"><img alt="Dr. Olivier Elemento" src="/a.jpg"></div>' +
          '<img alt="Dr. Kyu Rhee" src="/b.jpg">',
        { src: `${ORIGIN}/f.jpg`, alt: "trophies" },
      ),
    ).toBe("trophies Dr. Olivier Elemento Dr. Kyu Rhee");
  });

  it("survives a missing featured image and empty alts", () => {
    expect(parseCaptions('<img alt="" src="/a.jpg">', null)).toBe("");
    expect(parseCaptions("<p>No images.</p>", undefined)).toBe("");
  });
});

describe("validateArticles — tags + captionText (#2578)", () => {
  const base = {
    url: `${ORIGIN}/news/2026/07/a`,
    title: "T",
    excerpt: null,
    thumbnailUrl: null,
    publishedAt: "2026-07-16",
    cwids: [],
    bodyText: "b",
  };

  it("accepts a seed written BEFORE the fields existed", () => {
    // Optional in the JSON, like cwids: an older seed file must still load
    // rather than fail a run. They are required on the TypeScript type, so the
    // scraper can never quietly skip the tag tier.
    const [a] = validateArticles([base]);
    expect(a.tags).toEqual([]);
    expect(a.captionText).toBe("");
  });

  it("trims, drops empties and dedupes tags from a hand-edited seed", () => {
    const [a] = validateArticles([{ ...base, tags: [" Research ", "", "Research", "Patient Care"] }]);
    expect(a.tags).toEqual(["Research", "Patient Care"]);
  });

  it("rejects a non-array tags field and a control char in either", () => {
    expect(() => validateArticles([{ ...base, tags: "Research" }])).toThrow(/tags must be an array/);
    expect(() => validateArticles([{ ...base, tags: ["ok\u0000"] }])).toThrow(/invalid tag/);
    expect(() => validateArticles([{ ...base, captionText: "cap\u009f" }])).toThrow(
      /invalid captionText/,
    );
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

  it("does not throw on two entries sharing a path on the SAME page", async () => {
    // Both survive a filter that marks `seen` only afterwards, and
    // validateArticles rejects a duplicate url by failing the whole run.
    const dupPage = feed([story({ slug: "same" }), story({ slug: "same" })]);
    const got = await scrapeNews(new Set(), { get: fetcher({ "0": dupPage, "1": empty }) });
    expect(got.map((a) => a.url)).toEqual([u("same")]);
  });
});

describe("published-date floor", () => {
  const old = (slug: string, date: string) =>
    JSON.stringify({
      news_stories: [
        {
          story: {
            title: slug,
            path: `${ORIGIN}/news/2001/01/${slug}`,
            field_story_post_date: date,
            field_story_body: "<p>b</p>",
            field_story_teaser: "t",
            field_story_featured_image: null,
          },
        },
      ],
    });

  it("stops the walk at the first page entirely below the floor", async () => {
    const get = async (url: string) => {
      const p = url.match(/page=(\d+)/)?.[1] ?? "0";
      if (p === "0") return old("recent", "March 3, 2026");
      if (p === "1") return old("ancient", "March 3, 2001");
      throw new Error("walk should have stopped before page 2");
    };
    const got = await scrapeNews(new Set(), { get, minPublished: "2019-01-01" });
    expect(got.map((a) => a.title)).toEqual(["recent"]);
  });

  it("an empty NEWS_MIN_PUBLISHED walks the whole archive", async () => {
    const get = async (url: string) => {
      const p = url.match(/page=(\d+)/)?.[1] ?? "0";
      if (p === "0") return old("recent", "March 3, 2026");
      if (p === "1") return old("ancient", "March 3, 2001");
      return JSON.stringify({ news_stories: [] });
    };
    const got = await scrapeNews(new Set(), { get, minPublished: "" });
    expect(got.map((a) => a.title).sort()).toEqual(["ancient", "recent"]);
  });
});

describe("feedStories body-shape guard", () => {
  const page = (n: number, body: unknown) =>
    JSON.stringify({
      news_stories: Array.from({ length: n }, (_, i) => ({
        story: {
          title: `t${i}`,
          path: `${ORIGIN}/news/2026/07/s${i}`,
          field_story_post_date: "July 1, 2026",
          field_story_body: body,
          field_story_teaser: "x",
          field_story_featured_image: null,
        },
      })),
    });

  it("throws when the body field is re-typed away from a string", () => {
    // Drupal's formatted-text shape; every cwid would silently vanish.
    expect(() => feedStories(page(40, { value: "<p>b</p>", format: "full_html" }))).toThrow(
      /field_story_body/,
    );
  });

  it("tolerates a thin page below the 20-story sample size", () => {
    expect(() => feedStories(page(5, ""))).not.toThrow();
  });
});

describe("truncation", () => {
  it("cuts a long excerpt on a word boundary and marks the elision", () => {
    const long = `${"word ".repeat(600)}end`;
    const [a] = feedStories(feed([story({ slug: "t", teaser: long })]));
    expect(a.excerpt!.length).toBeLessThanOrEqual(2000);
    expect(a.excerpt!.endsWith("…")).toBe(true);
    // No dangling partial word before the ellipsis.
    expect(a.excerpt).not.toMatch(/\bwor…$/);
  });
});
