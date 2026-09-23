/** Report 9: journal-family matching and the awards defaults. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import {
  highImpactQueryString,
  journalFamilyOf,
  JOURNAL_FAMILIES,
  parseHighImpactParams,
} from "@/lib/edit/high-impact-pubs-report";

describe("journalFamilyOf", () => {
  it.each([
    ["JAMA", "jama"],
    ["JAMA Netw Open", "jama"],
    ["Lancet", "lancet"],
    ["N Engl J Med", "nejm"],
    ["NEJM Evid", "nejm"],
    ["J Clin Oncol", "jco"],
    ["Sci Transl Med", "stm"],
    ["Nature", "nature"],
    ["Nat Med", "nature"],
    ["Blood", "blood"],
    ["Circulation", "circulation"],
    ["Science", "science"],
    ["Cell", "cell"],
  ])("%s → %s", (abbrev, key) => {
    expect(journalFamilyOf(abbrev)?.key).toBe(key);
  });

  it.each(["Lancet Oncol", "Sci Adv", "Cell Rep", "Circ Res", "Nat Prod Rep", "Nat Sci Sleep", "JAMAx", null])(
    "%s → no family",
    (abbrev) => {
      expect(journalFamilyOf(abbrev)).toBeNull();
    },
  );
});

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
