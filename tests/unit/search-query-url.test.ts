import { describe, expect, it } from "vitest";
import {
  SEARCH_SOURCES,
  searchHref,
  searchQueryForUrl,
  withoutSearchSource,
} from "@/lib/search/query-url";

describe("searchQueryForUrl (#1954)", () => {
  it("rewrites a standalone & between words to 'and'", () => {
    expect(searchQueryForUrl("Head & neck squamous cell carcinoma")).toBe(
      "Head and neck squamous cell carcinoma",
    );
    expect(searchQueryForUrl("head&neck")).toBe("head and neck");
    expect(searchQueryForUrl("HEAD  &  NECK")).toBe("HEAD and NECK");
    expect(searchHref("head & neck")).toBe("/search?q=head%20and%20neck");
  });

  it("leaves an & that is not between two words alone", () => {
    expect(searchQueryForUrl("& neck")).toBe("& neck");
    expect(searchQueryForUrl("head &")).toBe("head &");
    expect(searchQueryForUrl("cancer")).toBe("cancer");
  });
});

describe("search source tag (typed vs suggested usage split)", () => {
  it("leaves a typed search untagged", () => {
    expect(searchHref("cancer")).toBe("/search?q=cancer");
  });

  it("tags a suggestion click with src=, after the #1954 rewrite", () => {
    expect(searchHref("head & neck", "chip")).toBe("/search?q=head%20and%20neck&src=chip");
    expect(searchHref("Neoplasms", "suggest")).toBe("/search?q=Neoplasms&src=suggest");
  });

  it("matches the rollup's tag list (cdk/lambda/cf-usage-rollup/queries.ts)", () => {
    expect([...SEARCH_SOURCES]).toEqual(["chip", "suggest"]);
  });

  it("drops src from search params and keeps everything else", () => {
    const sp = { q: "cancer", src: "chip", journal: ["Nature", "Cell"] };
    expect(withoutSearchSource(sp)).toEqual({ q: "cancer", journal: ["Nature", "Cell"] });
    expect(sp.src).toBe("chip"); // not mutated
    const plain = { q: "cancer" };
    expect(withoutSearchSource(plain)).toBe(plain);
  });
});
