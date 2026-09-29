import { describe, expect, it } from "vitest";
import { searchHref, searchQueryForUrl } from "@/lib/search/query-url";

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
