/** Report 9: the awards defaults and the people summary. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import {
  highImpactQueryString,
  JOURNAL_FAMILIES,
  parseHighImpactParams,
  summarizePeople,
  type HighImpactRow,
} from "@/lib/edit/high-impact-pubs-report";

describe("parseHighImpactParams", () => {
  const year = new Date().getFullYear();

  it("a bare URL gets the awards defaults: FT faculty, original research, first or last author, this year, every journal", () => {
    const p = parseHighImpactParams(new URLSearchParams());
    expect(p).toMatchObject({
      types: ["full_time_faculty"],
      atypes: ["Academic Article"],
      pos: "either",
      from: year,
      to: year,
      view: "summary",
    });
    expect(p.journals).toEqual(JOURNAL_FAMILIES.map((f) => f.key));
    // `view` alone is still a bare URL.
    expect(parseHighImpactParams(new URLSearchParams("view=publications"))).toMatchObject({
      types: ["full_time_faculty"],
      view: "publications",
    });
  });

  it("a submitted form is taken as-is; unknown journals are dropped; none left → every family", () => {
    const p = parseHighImpactParams(new URLSearchParams("pos=any&from=2024&to=2025&journal=nejm&journal=bogus"));
    expect(p).toMatchObject({ types: [], atypes: [], pos: "any", from: 2024, to: 2025, journals: ["nejm"] });
    expect(parseHighImpactParams(new URLSearchParams("pos=any&journal=bogus")).journals).toHaveLength(
      JOURNAL_FAMILIES.length,
    );
  });

  it("the query string round-trips through the parser", () => {
    const p = parseHighImpactParams(new URLSearchParams());
    expect(parseHighImpactParams(new URLSearchParams(highImpactQueryString(p, "publications")))).toEqual({
      ...p,
      view: "publications",
    });
  });
});

describe("summarizePeople", () => {
  const person = (cwid: string, position: "first" | "last" | "middle") => ({
    cwid,
    name: cwid.toUpperCase(),
    department: "Medicine",
    personType: "Full-time faculty",
    position,
  });
  const article = (pmid: string, journal: string, citations: number | null, people: ReturnType<typeof person>[]) =>
    ({ pmid, journal, citations, people }) as unknown as HighImpactRow;

  it("one row per person: articles, first/last counts, citations, journals by frequency; most articles first", () => {
    const rows = summarizePeople([
      article("1", "Nature", 10, [person("aaa", "first"), person("bbb", "last")]),
      article("2", "JAMA", null, [person("bbb", "first")]),
      article("3", "JAMA", 5, [person("bbb", "last")]),
    ]);
    expect(rows.map((r) => r.cwid)).toEqual(["bbb", "aaa"]);
    expect(rows[0]).toMatchObject({ articles: 3, firstAuthor: 1, lastAuthor: 2, citations: 15, journals: ["JAMA", "Nature"] });
    expect(rows[1]).toMatchObject({ articles: 1, firstAuthor: 1, lastAuthor: 0, citations: 10, journals: ["Nature"] });
  });

  it("a person listed twice on one article counts that article once", () => {
    const [row] = summarizePeople([article("1", "Cell", 2, [person("aaa", "first"), person("aaa", "last")])]);
    expect(row).toMatchObject({ articles: 1, firstAuthor: 1, lastAuthor: 1, citations: 2 });
  });
});
