import { describe, expect, it } from "vitest";

import { buildScholarIndex } from "@/etl/honors/lists/match";
import {
  matchFacultyAuthors,
  reciterAuthors,
  reconstructAbstract,
  type OpenAlexWork,
  type ReviewRow,
} from "@/etl/fundable-work/work";
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

describe("reciterAuthors", () => {
  const row = (
    status: ReviewRow["status"],
    top: string | null,
    resolution: string | null,
    pos: number,
    label: string,
  ): ReviewRow => ({
    status,
    top_cwid: top,
    resolution_cwid: resolution,
    author_position: pos,
    author_position_label: label,
  });
  const matched = [
    { cwid: "aaa1001", position: "last" },
    { cwid: "zzz9009", position: "first" },
  ];

  it("returns null when reciterdb has no rows, so the name matcher stands", () => {
    expect(reciterAuthors([], [], matched)).toBeNull();
  });

  it("resolves accepted/assigned to resolution_cwid, open/snoozed to top_cwid, drops rejected/dismissed", () => {
    const reviews = [
      row("accepted", "xxx0000", "aaa1001", 1, "first"),
      row("assigned", "yyy0000", "bbb2002", 2, "middle"),
      row("open", "ccc3003", null, 3, "middle"),
      row("snoozed", "ddd4004", null, 4, "middle"),
      row("rejected", "eee5005", "eee5005", 5, "middle"),
      row("dismissed", "fff6006", null, 6, "last"),
    ];
    expect(reciterAuthors(reviews, [], matched)).toEqual([
      { cwid: "aaa1001", position: "first" },
      { cwid: "bbb2002", position: "middle" },
      { cwid: "ccc3003", position: "middle" },
      { cwid: "ddd4004", position: "middle" },
    ]);
  });

  it("falls back to top_cwid on an accepted row with no resolution, and skips a null top_cwid", () => {
    expect(reciterAuthors([row("accepted", "aaa1001", null, 1, "first"), row("open", null, null, 2, "last")], [], [])).toEqual([
      { cwid: "aaa1001", position: "first" },
    ]);
  });

  it("replaces the name matcher when review rows exist; dedupes by cwid, earliest position wins", () => {
    const reviews = [row("open", "bbb2002", null, 9, "last"), row("accepted", "xxx", "bbb2002", 2, "middle")];
    expect(reciterAuthors(reviews, ["bbb2002"], matched)).toEqual([{ cwid: "bbb2002", position: "middle" }]);
  });

  it("adds external_article uids, positioned by the matcher when it knows them, else middle", () => {
    expect(reciterAuthors([row("open", "bbb2002", null, 1, "first")], ["aaa1001", "ggg7007"], matched)).toEqual([
      { cwid: "bbb2002", position: "first" },
      { cwid: "aaa1001", position: "last" },
      { cwid: "ggg7007", position: "middle" },
    ]);
  });

  it("with only external_article uids, keeps the matcher's authors alongside them", () => {
    expect(reciterAuthors([], ["ggg7007", "aaa1001"], matched)).toEqual([
      { cwid: "aaa1001", position: "last" },
      { cwid: "zzz9009", position: "first" },
      { cwid: "ggg7007", position: "middle" },
    ]);
  });
});

describe("modelAcceptsTemperature", () => {
  it("withholds temperature from the 5.x scorer model (Bedrock 400s on it)", () => {
    expect(modelAcceptsTemperature("us.anthropic.claude-sonnet-5-5")).toBe(false);
    expect(modelAcceptsTemperature("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(true);
  });
});
