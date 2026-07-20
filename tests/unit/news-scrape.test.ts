/**
 * Scraper parsing + incremental crawl (etl/news/scrape.ts), against fixture HTML
 * shaped like the WCM Drupal news markup. No network: crawlNewStubs takes an
 * injected fetcher.
 */
import { describe, expect, it } from "vitest";

import { bodyRegion, crawlNewStubs, listingRows, parseDetail } from "@/etl/news/scrape";

const ORIGIN = "https://research.weill.cornell.edu";

const card = (slug: string, title: string, excerpt: string) => `
<div class="views-row-odd clearfix view-teaser">
  <div class="views-field views-field-views-conditional-1"><span class="field-content"><a href="/about-us/news-updates/${slug}"><img class="news-thumb-117px-x-129px" src="${ORIGIN}/sites/default/files/news_images/${slug}.png" /></a></span></div>
  <div class="views-field views-field-views-conditional"><span class="field-content"><h2 class="teaser-title"><a href='/about-us/news-updates/${slug}'>${title}<i class="fa fa-angle-right"></i></a></h2></span></div>
  <div class="teaser-text"><p>${excerpt}</p></div>
</div>`;

const listingPage = (slugs: [string, string, string][]) =>
  `<html><body>${slugs.map(([s, t, e]) => card(s, t, e)).join("\n")}</body></html>`;

const detailPage = (opts: { date?: string; body: string }) => `
<html><body>
<div class="panel-pane pane-node-created post-date" >${opts.date ?? ""}</div>
<div class="panel-pane pane-entity-field pane-node-body" ><div class="">${opts.body}</div></div>
<div class="panel-pane pane-node-field-source-link"><a href="https://example.org">Source</a></div>
</body></html>`;

describe("listingRows", () => {
  it("parses teaser cards: slug, title (icon stripped), excerpt, same-origin thumbnail", () => {
    const rows = listingRows(listingPage([["a-b-c", "Title One", "Excerpt one."]]));
    expect(rows).toEqual([
      {
        url: `${ORIGIN}/about-us/news-updates/a-b-c`,
        title: "Title One",
        excerpt: "Excerpt one.",
        thumbnailUrl: `${ORIGIN}/sites/default/files/news_images/a-b-c.png`,
      },
    ]);
  });
});

describe("parseDetail", () => {
  it("extracts the ISO date, VIVO cwids, and body text", () => {
    const html = detailPage({
      date: "July 16, 2026",
      body: `Findings by <a href="https://vivo.weill.cornell.edu/display/cwid-XiM2002">Dr. Xiaojing Ma</a> and <a href="https://vivo.med.cornell.edu/display/cwid-gal2005">Dr. Gang Lin</a>.`,
    });
    const d = parseDetail(html);
    expect(d.publishedAt).toBe("2026-07-16");
    expect(d.cwids.sort()).toEqual(["gal2005", "xim2002"]);
    expect(d.bodyText).toContain("Dr. Xiaojing Ma");
    // The source-link pane is a different pane — its text must not leak in.
    expect(d.bodyText).not.toContain("Source");
  });

  it("returns null date when the page carries none", () => {
    expect(parseDetail(detailPage({ body: "No date here." })).publishedAt).toBeNull();
  });
});

describe("bodyRegion", () => {
  it("does not leak the pane class attribute into the body", () => {
    expect(bodyRegion(detailPage({ body: "Hello." }))).not.toContain("pane-node-body");
  });
});

describe("crawlNewStubs (incremental)", () => {
  const page0 = listingPage([
    ["new-1", "New 1", "e"],
    ["known-2", "Known 2", "e"],
  ]);
  const page1 = listingPage([["known-3", "Known 3", "e"]]);
  const fetcher = (byPage: Record<string, string | null>) => async (url: string) => {
    const m = url.match(/page=(\d+)/);
    return byPage[m ? m[1] : "0"] ?? null;
  };

  it("stops once a page is entirely already ingested", async () => {
    const known = new Set([
      `${ORIGIN}/about-us/news-updates/known-2`,
      `${ORIGIN}/about-us/news-updates/known-3`,
    ]);
    const stubs = await crawlNewStubs(fetcher({ "0": page0, "1": page1 }), known, 50);
    // page0 has one new article; page1 is all-known so the crawl stops before it.
    expect(stubs.map((s) => s.url)).toEqual([`${ORIGIN}/about-us/news-updates/new-1`]);
  });

  it("backfill (empty known set) walks until a page repeats", async () => {
    // Drupal serves the last page for page= past the end; the repeat halts it.
    const stubs = await crawlNewStubs(fetcher({ "0": page0, "1": page1, "2": page1 }), new Set(), 50);
    expect(stubs.map((s) => s.url).sort()).toEqual([
      `${ORIGIN}/about-us/news-updates/known-2`,
      `${ORIGIN}/about-us/news-updates/known-3`,
      `${ORIGIN}/about-us/news-updates/new-1`,
    ]);
  });
});
