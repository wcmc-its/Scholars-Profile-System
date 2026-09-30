/**
 * Unit Page v2 — roster toolbar sort + name/title filter (lib/roster-sort.ts),
 * the one comparator shared by the SSR roster loaders, the members route and
 * the grouped center roster's in-browser sort. Synthetic names only.
 */
import { describe, expect, it } from "vitest";
import {
  compareRoster,
  matchesRosterQuery,
  normalizeRosterQuery,
  parseRosterSort,
  rankRoster,
  ROSTER_SORT_OPTIONS,
} from "@/lib/roster-sort";

const e = (
  cwid: string,
  preferredName: string,
  pubCount = 0,
  grantCount = 0,
  primaryTitle: string | null = null,
) => ({ cwid, preferredName, pubCount, grantCount, primaryTitle });

describe("parseRosterSort", () => {
  it.each([
    [null, "last"],
    [undefined, "last"],
    ["last", "last"],
    ["pubs", "pubs"],
    ["grants", "grants"],
    // The retired Name Z–A option and the Publications / Grants tabs' own
    // values share `?sort=` and must fall back, not throw.
    ["name-desc", "last"],
    ["most_cited", "last"],
    ["end_date", "last"],
  ])("%s → %s", (raw, want) => {
    expect(parseRosterSort(raw as string | null | undefined)).toBe(want);
  });

  it("offers the mock's three options in order", () => {
    expect(ROSTER_SORT_OPTIONS.map((o) => o.label)).toEqual([
      "Last name A–Z",
      "Most publications",
      "Most grants",
    ]);
  });
});

describe("rankRoster — last", () => {
  it("orders by surname, not first name", () => {
    const ranked = rankRoster([e("1", "Amy Zimmer"), e("2", "Zed Adams")], { sort: "last" });
    expect(ranked.map((r) => r.preferredName)).toEqual(["Zed Adams", "Amy Zimmer"]);
  });

  it("strips the name-collision disambiguation tail before keying", () => {
    const ranked = rankRoster(
      [e("1", "Jane Doe (Radiology)"), e("2", "Ann Carter"), e("3", "Bo Evans")],
      { sort: "last" },
    );
    expect(ranked.map((r) => r.cwid)).toEqual(["2", "1", "3"]);
  });

  it("breaks surname ties by full name, then cwid", () => {
    const ranked = rankRoster(
      [e("c9", "Bo Smith"), e("c2", "Al Smith"), e("c1", "Bo Smith")],
      { sort: "last" },
    );
    expect(ranked.map((r) => r.cwid)).toEqual(["c2", "c1", "c9"]);
  });

  it("uses a precomputed lastKey when present", () => {
    const ranked = rankRoster(
      [
        { ...e("1", "Amy Zimmer"), lastKey: "b" },
        { ...e("2", "Zed Adams"), lastKey: "c" },
      ],
      { sort: "last" },
    );
    expect(ranked.map((r) => r.cwid)).toEqual(["1", "2"]);
  });

  it("does not mutate its input", () => {
    const input = [e("1", "Amy Zimmer"), e("2", "Zed Adams")];
    rankRoster(input, { sort: "last" });
    expect(input.map((r) => r.cwid)).toEqual(["1", "2"]);
  });
});

describe("rankRoster — counts", () => {
  const rows = [
    e("1", "Amy Zimmer", 5, 0),
    e("2", "Zed Adams", 5, 2),
    e("3", "Cy Brown", 9, 1),
  ];

  it("pubs: descending, surname tiebreak", () => {
    expect(rankRoster(rows, { sort: "pubs" }).map((r) => r.cwid)).toEqual(["3", "2", "1"]);
  });

  it("grants: descending, surname tiebreak", () => {
    expect(rankRoster(rows, { sort: "grants" }).map((r) => r.cwid)).toEqual(["2", "3", "1"]);
    expect(compareRoster(rows[0], rows[0], "grants")).toBe(0);
  });
});

describe("query matching", () => {
  it("is case- and accent-insensitive", () => {
    expect(matchesRosterQuery(e("1", "José Álvarez"), "jose alvarez")).toBe(true);
    expect(matchesRosterQuery(e("1", "Jose Alvarez"), "JOSÉ")).toBe(true);
  });

  it("matches the title", () => {
    expect(matchesRosterQuery(e("1", "Ann Lee", 0, 0, "Chief of Cardiology"), "cardio")).toBe(
      true,
    );
    expect(matchesRosterQuery(e("1", "Ann Lee", 0, 0, null), "cardio")).toBe(false);
  });

  it("an empty or whitespace query matches all", () => {
    expect(matchesRosterQuery(e("1", "Ann Lee"), "")).toBe(true);
    expect(matchesRosterQuery(e("1", "Ann Lee"), "   ")).toBe(true);
    expect(rankRoster([e("1", "B B"), e("2", "A A")], { sort: "last", q: " " })).toHaveLength(2);
  });

  it("rankRoster filters by q", () => {
    const ranked = rankRoster([e("1", "Ann Lee"), e("2", "Bo Smith")], { sort: "last", q: "smi" });
    expect(ranked.map((r) => r.cwid)).toEqual(["2"]);
  });

  it("normalizeRosterQuery trims, collapses whitespace and caps at 100", () => {
    expect(normalizeRosterQuery("  a   b  ")).toBe("a b");
    expect(normalizeRosterQuery(null)).toBe("");
    expect(normalizeRosterQuery("x".repeat(150))).toHaveLength(100);
  });
});
