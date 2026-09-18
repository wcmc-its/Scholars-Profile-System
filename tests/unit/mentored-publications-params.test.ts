/**
 * `lib/edit/mentored-publications-params.ts` — the query contract the
 * `/edit/reports/7` page and its `.xlsx` route share. Pure; `@/lib/db` is
 * stubbed only because the module's imports reach it at module scope.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import { mentoredPubsQueryString, parseMentoredPubsParams } from "@/lib/edit/mentored-publications-params";

const DEFAULTS = { years: null, program: null, tail: 1, pubs: "mentored", view: "summary" } as const;

describe("parseMentoredPubsParams", () => {
  it("defaults: no years (null), every scope (program null), tail 1, mentored set, summary view", () => {
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

  it("years: a malformed token is an error, not a silent drop", () => {
    expect(parseMentoredPubsParams({ years: "2024,abc" })).toEqual({ ok: false, error: "invalid_years" });
    expect(parseMentoredPubsParams({ years: "24" })).toEqual({ ok: false, error: "invalid_years" });
    expect(parseMentoredPubsParams({ years: "1800" })).toEqual({ ok: false, error: "invalid_years" });
  });

  it("program: a bucket, 'all', or absent; anything else is an error", () => {
    expect(parseMentoredPubsParams({ program: "md" })).toMatchObject({ ok: true, value: { program: "md" } });
    expect(parseMentoredPubsParams({ program: "MDPHD" })).toMatchObject({ ok: true, value: { program: "mdphd" } });
    expect(parseMentoredPubsParams({ program: "all" })).toMatchObject({ ok: true, value: { program: null } });
    expect(parseMentoredPubsParams({ program: "phd" })).toEqual({ ok: false, error: "invalid_program" });
    expect(parseMentoredPubsParams({ program: "*" })).toEqual({ ok: false, error: "invalid_program" });
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
      { years: [2024, 2025], program: "md" as const, tail: 2, pubs: "mentored" as const, view: "summary" as const },
      { years: [], program: null, tail: 0, pubs: "all" as const, view: "publications" as const },
      { years: null, program: "ecr" as const, tail: 1, pubs: "all" as const, view: "summary" as const },
    ];
    for (const value of cases) {
      const qs = mentoredPubsQueryString(value);
      expect(parseMentoredPubsParams(new URLSearchParams(qs))).toEqual({ ok: true, value });
    }
    // `pubs` always written (the download carries it); `view` only when not the default.
    expect(mentoredPubsQueryString({ ...DEFAULTS, years: [2024, 2025] })).toBe(
      "years=2024%2C2025&program=all&tail=1&pubs=mentored",
    );
    expect(mentoredPubsQueryString({ ...DEFAULTS, years: [] })).toBe("years=all&program=all&tail=1&pubs=mentored");
    expect(mentoredPubsQueryString({ ...DEFAULTS, years: [], pubs: "all", view: "publications" })).toBe(
      "years=all&program=all&tail=1&pubs=all&view=publications",
    );
  });
});
