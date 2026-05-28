/**
 * `urlToPageRoute` (#538 PR-1) — URL → Next.js route pattern for
 * feedback-submission aggregation.
 */
import { describe, expect, it } from "vitest";

import { urlToPageRoute } from "@/lib/feedback/page-route";

describe("urlToPageRoute", () => {
  const ORIGIN = "https://scholars.weill.cornell.edu";

  it("maps a scholar profile to /scholars/[slug]", () => {
    expect(urlToPageRoute(`${ORIGIN}/scholars/jane-smith`)).toEqual("/scholars/[slug]");
  });

  it("maps department, division, center, topic — same shape", () => {
    expect(urlToPageRoute(`${ORIGIN}/departments/medicine`)).toEqual("/departments/[slug]");
    expect(urlToPageRoute(`${ORIGIN}/divisions/oncology`)).toEqual("/divisions/[slug]");
    expect(urlToPageRoute(`${ORIGIN}/centers/cancer-center`)).toEqual("/centers/[slug]");
    expect(urlToPageRoute(`${ORIGIN}/topics/breast-cancer`)).toEqual("/topics/[slug]");
  });

  it("maps /edit and /edit/scholar/[cwid] separately", () => {
    expect(urlToPageRoute(`${ORIGIN}/edit`)).toEqual("/edit");
    expect(urlToPageRoute(`${ORIGIN}/edit/scholar/abc1234`)).toEqual("/edit/scholar/[cwid]");
    expect(urlToPageRoute(`${ORIGIN}/edit/publication/12345678`)).toEqual("/edit/publication/[pmid]");
    expect(urlToPageRoute(`${ORIGIN}/edit/slug-requests`)).toEqual("/edit/slug-requests");
  });

  it("maps /about/feedback specifically, collapses other /about/* to /about", () => {
    expect(urlToPageRoute(`${ORIGIN}/about/feedback`)).toEqual("/about/feedback");
    expect(urlToPageRoute(`${ORIGIN}/about`)).toEqual("/about");
    expect(urlToPageRoute(`${ORIGIN}/about/help`)).toEqual("/about");
    expect(urlToPageRoute(`${ORIGIN}/about/methodology`)).toEqual("/about");
  });

  it("maps homepage, search, browse", () => {
    expect(urlToPageRoute(`${ORIGIN}/`)).toEqual("/");
    expect(urlToPageRoute(`${ORIGIN}/search`)).toEqual("/search");
    expect(urlToPageRoute(`${ORIGIN}/browse`)).toEqual("/browse");
  });

  it("ignores the query string when matching the pattern", () => {
    expect(urlToPageRoute(`${ORIGIN}/scholars/jane?ref=foo`)).toEqual("/scholars/[slug]");
    expect(urlToPageRoute(`${ORIGIN}/search?q=onco`)).toEqual("/search");
  });

  it("ignores a trailing slash on non-root paths", () => {
    expect(urlToPageRoute(`${ORIGIN}/scholars/jane/`)).toEqual("/scholars/[slug]");
    expect(urlToPageRoute(`${ORIGIN}/search/`)).toEqual("/search");
  });

  it("falls back to the raw pathname for unrecognized routes", () => {
    expect(urlToPageRoute(`${ORIGIN}/something/novel`)).toEqual("/something/novel");
  });

  it("returns null for invalid / empty input", () => {
    expect(urlToPageRoute(null)).toBeNull();
    expect(urlToPageRoute(undefined)).toBeNull();
    expect(urlToPageRoute("")).toBeNull();
    expect(urlToPageRoute("not a url")).toBeNull();
  });

  it("truncates a very long unrecognized pathname to the 255-char column bound", () => {
    const long = "/a" + "/path".repeat(80); // way past 255
    const out = urlToPageRoute(`${ORIGIN}${long}`);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(255);
  });
});
