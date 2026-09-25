/**
 * `lib/edit/mentored-publications-params.ts` — the query contract the
 * `/edit/reports/7` page and its `.xlsx` route share. Pure; `@/lib/db` is
 * stubbed only because the module's imports reach it at module scope.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import {
  gradYearsLabel,
  hasMentoredPubsFacets,
  isGappyYearSelection,
  MENTORED_PUBS_DEFAULT_PARAMS,
  mentoredPubsQueryString,
  parseMentoredPubsParams,
  type MentoredPubsParams,
} from "@/lib/edit/mentored-publications-params";

const DEFAULTS = MENTORED_PUBS_DEFAULT_PARAMS;

describe("parseMentoredPubsParams", () => {
  it("defaults: no years (null), no types (null), tail 1, mentored set, summary view, no facets, no q", () => {
    expect(DEFAULTS).toEqual({
      years: null,
      types: null,
      tail: 1,
      pubs: "mentored",
      view: "summary",
      window: [],
      position: [],
      pubYears: [],
      mentors: [],
      withPubs: false,
      q: "",
    });
    expect(parseMentoredPubsParams({})).toEqual({ ok: true, value: DEFAULTS });
    expect(parseMentoredPubsParams(new URLSearchParams(""))).toEqual({ ok: true, value: DEFAULTS });
  });

  it("pubs: mentored | all (case-insensitive); anything else is an error", () => {
    expect(parseMentoredPubsParams({ pubs: "all" })).toMatchObject({ ok: true, value: { pubs: "all" } });
    expect(parseMentoredPubsParams({ pubs: "Mentored" })).toMatchObject({ ok: true, value: { pubs: "mentored" } });
    expect(parseMentoredPubsParams({ pubs: "" })).toMatchObject({ ok: true, value: { pubs: "mentored" } });
    expect(parseMentoredPubsParams({ pubs: "everything" })).toEqual({ ok: false, error: "invalid_pubs" });
    expect(parseMentoredPubsParams({ pubs: "*" })).toEqual({ ok: false, error: "invalid_pubs" });
  });

  it("view: summary | publications; anything else is an error", () => {
    expect(parseMentoredPubsParams({ view: "publications" })).toMatchObject({
      ok: true,
      value: { view: "publications" },
    });
    expect(parseMentoredPubsParams({ view: "SUMMARY" })).toMatchObject({ ok: true, value: { view: "summary" } });
    expect(parseMentoredPubsParams({ view: "raw" })).toEqual({ ok: false, error: "invalid_view" });
  });

  it("years: comma list, repeated keys, or both; deduped and sorted; 'all' = []", () => {
    expect(parseMentoredPubsParams({ years: "2025,2024" })).toMatchObject({ ok: true, value: { years: [2024, 2025] } });
    expect(parseMentoredPubsParams({ years: ["2025", "2024", "2025"] })).toMatchObject({
      ok: true,
      value: { years: [2024, 2025] },
    });
    expect(parseMentoredPubsParams(new URLSearchParams("years=2024&years=2023,2025"))).toMatchObject({
      ok: true,
      value: { years: [2023, 2024, 2025] },
    });
    expect(parseMentoredPubsParams({ years: "all" })).toMatchObject({ ok: true, value: { years: [] } });
    expect(parseMentoredPubsParams({ years: ["2024", "all"] })).toMatchObject({ ok: true, value: { years: [] } });
  });

  it("years: 'unknown' = null, always last; 'all' still wins", () => {
    expect(parseMentoredPubsParams({ years: "2025,unknown" })).toMatchObject({ ok: true, value: { years: [2025, null] } });
    expect(parseMentoredPubsParams({ years: ["unknown", "2025"] })).toMatchObject({
      ok: true,
      value: { years: [2025, null] },
    });
    expect(parseMentoredPubsParams({ years: "Unknown" })).toMatchObject({ ok: true, value: { years: [null] } });
    expect(parseMentoredPubsParams({ years: "all,unknown" })).toMatchObject({ ok: true, value: { years: [] } });
  });

  it("years: a malformed token is an error, not a silent drop", () => {
    expect(parseMentoredPubsParams({ years: "2024,abc" })).toEqual({ ok: false, error: "invalid_years" });
    expect(parseMentoredPubsParams({ years: "24" })).toEqual({ ok: false, error: "invalid_years" });
    expect(parseMentoredPubsParams({ years: "1800" })).toEqual({ ok: false, error: "invalid_years" });
  });

  it("types: comma list, repeated keys, or both; deduped, in vocabulary order; case-insensitive", () => {
    expect(parseMentoredPubsParams({ mtype: "thesis,aoc" })).toMatchObject({
      ok: true,
      value: { types: ["aoc", "thesis"] },
    });
    expect(parseMentoredPubsParams({ mtype: ["likely", "aoc", "likely"] })).toMatchObject({
      ok: true,
      value: { types: ["aoc", "likely"] },
    });
    expect(
      parseMentoredPubsParams(new URLSearchParams("mtype=postdoc&mtype=aoc,ecr")),
    ).toMatchObject({
      ok: true,
      value: { types: ["aoc", "ecr", "postdoc"] },
    });
    expect(parseMentoredPubsParams({ mtype: "AOC" })).toMatchObject({
      ok: true,
      value: { types: ["aoc"] },
    });
    expect(parseMentoredPubsParams({ mtype: "" })).toMatchObject({
      ok: true,
      value: { types: null },
    });
  });

  it("types: an unknown key is an error, not a silent drop", () => {
    expect(parseMentoredPubsParams({ mtype: "aoc,phd" })).toEqual({
      ok: false,
      error: "invalid_types",
    });
    expect(parseMentoredPubsParams({ mtype: "md" })).toEqual({ ok: false, error: "invalid_types" });
    expect(parseMentoredPubsParams({ mtype: "*" })).toEqual({ ok: false, error: "invalid_types" });
  });

  it("legacy `types=` (mtype's old name) is read only when `mtype` is absent; never `type` (person type)", () => {
    expect(parseMentoredPubsParams({ types: "thesis,aoc" })).toMatchObject({
      ok: true,
      value: { types: ["aoc", "thesis"] },
    });
    expect(parseMentoredPubsParams(new URLSearchParams("mtype=aoc&types=thesis"))).toMatchObject({
      ok: true,
      value: { types: ["aoc"] },
    });
    expect(parseMentoredPubsParams({ types: "phd" })).toEqual({ ok: false, error: "invalid_types" });
    expect(parseMentoredPubsParams({ type: "aoc" })).toMatchObject({ ok: true, value: { types: null } });
  });

  it("legacy program=<scope> with no types reads as that scope's roster type; all / unknown → null, never an error", () => {
    expect(parseMentoredPubsParams({ program: "md" })).toMatchObject({
      ok: true,
      value: { types: ["aoc"] },
    });
    expect(parseMentoredPubsParams({ program: "MDPHD" })).toMatchObject({
      ok: true,
      value: { types: ["mdphd"] },
    });
    expect(parseMentoredPubsParams({ program: "ecr" })).toMatchObject({
      ok: true,
      value: { types: ["ecr"] },
    });
    expect(parseMentoredPubsParams({ program: "all" })).toMatchObject({
      ok: true,
      value: { types: null },
    });
    expect(parseMentoredPubsParams({ program: "phd" })).toMatchObject({
      ok: true,
      value: { types: null },
    });
    expect(parseMentoredPubsParams({ program: "*" })).toMatchObject({
      ok: true,
      value: { types: null },
    });
    // `types` wins over a stray `program`.
    expect(parseMentoredPubsParams({ program: "md", types: "thesis" })).toMatchObject({
      ok: true,
      value: { types: ["thesis"] },
    });
  });

  it("tail: 0..3 only", () => {
    expect(parseMentoredPubsParams({ tail: "0" })).toMatchObject({ ok: true, value: { tail: 0 } });
    expect(parseMentoredPubsParams({ tail: "3" })).toMatchObject({ ok: true, value: { tail: 3 } });
    expect(parseMentoredPubsParams({ tail: "4" })).toEqual({ ok: false, error: "invalid_tail" });
    expect(parseMentoredPubsParams({ tail: "-1" })).toEqual({ ok: false, error: "invalid_tail" });
    expect(parseMentoredPubsParams({ tail: "x" })).toEqual({ ok: false, error: "invalid_tail" });
  });
});

describe("mentoredPubsQueryString", () => {
  it("round-trips through the parser", () => {
    const cases: MentoredPubsParams[] = [
      {
        ...DEFAULTS,
        years: [2024, 2025],
        types: ["aoc" as const],
        tail: 2,
        pubs: "mentored" as const,
        view: "summary" as const,
      },
      { ...DEFAULTS, years: [], types: null, tail: 0, pubs: "all" as const, view: "publications" as const },
      {
        ...DEFAULTS,
        years: null,
        types: ["aoc" as const, "ecr" as const, "thesis" as const, "likely" as const],
        tail: 1,
        pubs: "all" as const,
        view: "summary" as const,
      },
      {
        ...DEFAULTS,
        years: [2025, null],
        types: ["possible" as const],
        tail: 1,
        pubs: "mentored" as const,
        view: "summary" as const,
      },
      {
        ...DEFAULTS,
        years: [2026],
        types: ["aoc" as const],
        window: ["yes", "unknown"],
        position: ["first"],
        pubYears: [2023, 2024],
        mentors: ["abc1001", "xyz2002"],
        withPubs: true,
        view: "publications",
        q: "smith",
      },
    ];
    for (const value of cases) {
      const qs = mentoredPubsQueryString(value);
      expect(parseMentoredPubsParams(new URLSearchParams(qs))).toEqual({ ok: true, value });
    }
    // `types` (comma-joined) and `pubs` always written when known (the
    // download carries them); `program` never; `view` only when not the default.
    expect(
      mentoredPubsQueryString({ ...DEFAULTS, years: [2024, 2025], types: ["aoc", "thesis"] }),
    ).toBe("years=2024%2C2025&mtype=aoc%2Cthesis&tail=1&pubs=mentored");
    expect(mentoredPubsQueryString({ ...DEFAULTS, years: [] })).toBe(
      "years=all&tail=1&pubs=mentored",
    );
    expect(mentoredPubsQueryString({ ...DEFAULTS, years: [2025, null], types: ["aoc"] })).toBe(
      "years=2025%2Cunknown&mtype=aoc&tail=1&pubs=mentored",
    );
    expect(
      mentoredPubsQueryString({
        ...DEFAULTS,
        years: [],
        types: ["aoc"],
        pubs: "all",
        view: "publications",
      }),
    ).toBe("years=all&mtype=aoc&tail=1&pubs=all&view=publications");
  });
});

describe("the redesign's params (2026-09-24)", () => {
  it("an old link carries none of them: every facet empty, and its query string is unchanged", () => {
    const old = parseMentoredPubsParams({ years: "2025,2026", mtype: "aoc", tail: "1", pubs: "mentored" });
    expect(old).toEqual({
      ok: true,
      value: { ...DEFAULTS, years: [2025, 2026], types: ["aoc"] },
    });
    expect(hasMentoredPubsFacets(old.ok ? old.value : DEFAULTS)).toBe(false);
    expect(mentoredPubsQueryString(old.ok ? old.value : DEFAULTS)).toBe(
      "years=2025%2C2026&mtype=aoc&tail=1&pubs=mentored",
    );
  });

  it("the range fields fold into the years list; `years` wins when both are present; from/to swap", () => {
    expect(parseMentoredPubsParams({ grad_from: "2024", grad_to: "2026" })).toMatchObject({
      ok: true,
      value: { years: [2024, 2025, 2026] },
    });
    expect(parseMentoredPubsParams({ grad_from: "2026", grad_to: "2024", grad_unknown: "1" })).toMatchObject({
      ok: true,
      value: { years: [2024, 2025, 2026, null] },
    });
    // One end blank ("None") → that single year.
    expect(parseMentoredPubsParams({ grad_from: "", grad_to: "2025" })).toMatchObject({
      ok: true,
      value: { years: [2025] },
    });
    // Both blank + unknown → only learners with no graduation year.
    expect(parseMentoredPubsParams({ grad_from: "", grad_to: "", grad_unknown: "1" })).toMatchObject({
      ok: true,
      value: { years: [null] },
    });
    // Nothing chosen → absent (the caller's default).
    expect(parseMentoredPubsParams({ grad_from: "", grad_to: "" })).toMatchObject({ ok: true, value: { years: null } });
    expect(parseMentoredPubsParams({ years: "2019", grad_from: "2024", grad_to: "2026" })).toMatchObject({
      ok: true,
      value: { years: [2019] },
    });
    expect(parseMentoredPubsParams({ grad_from: "20x4", grad_to: "2026" })).toEqual({
      ok: false,
      error: "invalid_years",
    });
    // The range is never written back — every link speaks `years=`.
    const r = parseMentoredPubsParams({ grad_from: "2025", grad_to: "2026", grad_unknown: "1" });
    expect(mentoredPubsQueryString(r.ok ? r.value : DEFAULTS)).toBe("years=2025%2C2026%2Cunknown&tail=1&pubs=mentored");
  });

  it("window / position: fixed vocabularies, comma or repeated, in display order; anything else is an error", () => {
    expect(parseMentoredPubsParams({ window: ["unknown", "YES"], position: "last,first" })).toMatchObject({
      ok: true,
      value: { window: ["yes", "unknown"], position: ["first", "last"] },
    });
    expect(parseMentoredPubsParams({ window: "maybe" })).toEqual({ ok: false, error: "invalid_window" });
    expect(parseMentoredPubsParams({ position: "any" })).toEqual({ ok: false, error: "invalid_position" });
  });

  it("pubyear: four-digit years, sorted; mentor: CWID-shaped tokens, lower-cased and sorted; withpubs: 1", () => {
    expect(
      parseMentoredPubsParams({ pubyear: "2024,2021", mentor: ["XYZ2002", "abc1001"], withpubs: "1" }),
    ).toMatchObject({
      ok: true,
      value: { pubYears: [2021, 2024], mentors: ["abc1001", "xyz2002"], withPubs: true },
    });
    expect(parseMentoredPubsParams({ withpubs: "0" })).toMatchObject({ ok: true, value: { withPubs: false } });
    expect(parseMentoredPubsParams({ pubyear: "24" })).toEqual({ ok: false, error: "invalid_pubyear" });
    expect(parseMentoredPubsParams({ mentor: "a b" })).toEqual({ ok: false, error: "invalid_mentor" });
  });

  it("q is free text, trimmed, never an error", () => {
    expect(parseMentoredPubsParams({ q: "  Smith, J " })).toMatchObject({ ok: true, value: { q: "Smith, J" } });
  });

  it("gradYearsLabel reads a range, a list, unknown and all", () => {
    expect(gradYearsLabel([])).toBe("All years");
    expect(gradYearsLabel([2026, 2027, null])).toBe("2026–2027 + unknown");
    expect(gradYearsLabel([2025])).toBe("2025");
    expect(gradYearsLabel([2019, 2027])).toBe("2019, 2027");
    expect(gradYearsLabel([null])).toBe("No graduation year");
  });

  it("gradYearsLabel with choices: a gap is a year that EXISTS and isn't picked, not a missing whole number", () => {
    // No class graduated in 2020: 2019 + 2021 is the range 2019–2021.
    expect(gradYearsLabel([2019, 2021], [2023, 2021, 2019, null])).toBe("2019–2021");
    expect(gradYearsLabel([2019, 2021, null], [2021, 2019])).toBe("2019–2021 + unknown");
    // 2020 exists and is skipped: listed.
    expect(gradYearsLabel([2019, 2021], [2021, 2020, 2019])).toBe("2019, 2021");
    expect(isGappyYearSelection([2019, 2021], [2021, 2019])).toBe(false);
    expect(isGappyYearSelection([2019, 2021], [2021, 2020, 2019])).toBe(true);
    expect(isGappyYearSelection([2019, 2021])).toBe(true);
    expect(isGappyYearSelection([2019], [2021, 2020, 2019])).toBe(false);
  });

  it("grad_exact: a gappy list is kept exactly while the selects still span it; moving either select widens to the range", () => {
    // Untouched: another control changed, the form resubmits the same list.
    expect(parseMentoredPubsParams({ grad_from: "2019", grad_to: "2027", grad_exact: "2019,2027" })).toMatchObject({
      ok: true,
      value: { years: [2019, 2027] },
    });
    expect(
      parseMentoredPubsParams({ grad_from: "2019", grad_to: "2027", grad_exact: "2027,2019", grad_unknown: "1" }),
    ).toMatchObject({ ok: true, value: { years: [2019, 2027, null] } });
    // Touched: the range wins.
    const widened = parseMentoredPubsParams({ grad_from: "2020", grad_to: "2027", grad_exact: "2019,2027" });
    expect(widened.ok && widened.value.years).toEqual([2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027]);
    const toMoved = parseMentoredPubsParams({ grad_from: "2019", grad_to: "2021", grad_exact: "2019,2027" });
    expect(toMoved.ok && toMoved.value.years).toEqual([2019, 2020, 2021]);
    expect(parseMentoredPubsParams({ grad_from: "", grad_to: "", grad_exact: "2019,2027" })).toMatchObject({
      ok: true,
      value: { years: null },
    });
    // `years` still wins; a malformed token is an error.
    expect(parseMentoredPubsParams({ years: "2024", grad_from: "2019", grad_to: "2027", grad_exact: "2019,2027" })).toMatchObject({
      ok: true,
      value: { years: [2024] },
    });
    expect(parseMentoredPubsParams({ grad_from: "2019", grad_to: "2027", grad_exact: "2019,x" })).toEqual({
      ok: false,
      error: "invalid_years",
    });
  });
});
