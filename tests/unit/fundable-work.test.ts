import { describe, expect, it } from "vitest";

import { buildScholarIndex } from "@/etl/honors/lists/match";
import { matchFacultyAuthors, reconstructAbstract, type OpenAlexWork } from "@/etl/fundable-work/work";
import { modelAcceptsTemperature } from "@/lib/llm/models";

const WCM = { id: "https://openalex.org/I4387153466" };
const QATAR = { id: "https://openalex.org/I4210152471" };

function work(authorships: OpenAlexWork["authorships"]): OpenAlexWork {
  return {
    id: "https://openalex.org/W1",
    doi: null,
    title: "t",
    type: "preprint",
    publication_date: "2026-01-01",
    primary_location: null,
    abstract_inverted_index: null,
    authorships,
  };
}

const index = buildScholarIndex([
  { cwid: "aaa1001", preferredName: "Jane Doe", fullName: "Jane Q Doe" },
  { cwid: "bbb2002", preferredName: "John Smith", fullName: "John Smith" },
  { cwid: "ccc3003", preferredName: "John Smith", fullName: "John A Smith" },
]);

describe("reconstructAbstract", () => {
  it("restores word order from the inverted index", () => {
    expect(reconstructAbstract({ cancer: [1], Targeting: [0], cells: [3], stem: [2] })).toBe(
      "Targeting cancer stem cells",
    );
    expect(reconstructAbstract(null)).toBe("");
  });
});

describe("matchFacultyAuthors", () => {
  it("links a WCM author with a unique full-name match, keeping position", () => {
    const w = work([{ author_position: "last", author: { display_name: "Jane Doe" }, institutions: [WCM] }]);
    expect(matchFacultyAuthors(w, index)).toEqual([{ cwid: "aaa1001", position: "last" }]);
  });

  it("ignores non-WCM authorships, including WCM-Qatar", () => {
    const w = work([
      { author_position: "first", author: { display_name: "Jane Doe" }, institutions: [QATAR] },
      { author_position: "middle", author: { display_name: "Jane Doe" }, institutions: [] },
    ]);
    expect(matchFacultyAuthors(w, index)).toEqual([]);
  });

  it("drops an ambiguous name rather than guess", () => {
    const w = work([{ author_position: "first", author: { display_name: "John Smith" }, institutions: [WCM] }]);
    expect(matchFacultyAuthors(w, index)).toEqual([]);
  });
});

describe("modelAcceptsTemperature", () => {
  it("withholds temperature from the 5.x scorer model (Bedrock 400s on it)", () => {
    expect(modelAcceptsTemperature("us.anthropic.claude-sonnet-5-5")).toBe(false);
    expect(modelAcceptsTemperature("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(true);
  });
});
