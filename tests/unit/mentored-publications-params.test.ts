/**
 * `lib/edit/mentored-publications-params.ts` — the query contract the
 * `/edit/reports/7` page and its `.xlsx` route share. Pure; `@/lib/db` is
 * stubbed only because the module's imports reach it at module scope.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import { mentoredPubsQueryString, parseMentoredPubsParams } from "@/lib/edit/mentored-publications-params";

const DEFAULTS = { years: null, types: null, tail: 1, pubs: "mentored", view: "summary" } as const;

describe("parseMentoredPubsParams", () => {
  it("defaults: no years (null), no types (null), tail 1, mentored set, summary view", () => {
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
    const cases = [
      {
        years: [2024, 2025],
        types: ["aoc" as const],
        tail: 2,
        pubs: "mentored" as const,
        view: "summary" as const,
      },
      { years: [], types: null, tail: 0, pubs: "all" as const, view: "publications" as const },
      {
        years: null,
        types: ["aoc" as const, "ecr" as const, "thesis" as const, "likely" as const],
        tail: 1,
        pubs: "all" as const,
        view: "summary" as const,
      },
      {
        years: [2025, null],
        types: ["possible" as const],
        tail: 1,
        pubs: "mentored" as const,
        view: "summary" as const,
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
