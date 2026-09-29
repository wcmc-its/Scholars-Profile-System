/**
 * Report 13 (Grants citing the core) — the pure pieces of
 * `lib/edit/core-grants-report.ts`: `awardKey` (IC + serial, the 09-28 probe's
 * rule), `collapseAwards` (per-person InfoEd rows and renewals fold into ONE
 * award; PI = the PI-role row else the first holder; period = min start – max
 * end over every row; Active = as-of inside the period; papers = distinct
 * linked PMIDs) and `filterAwards` (status / funder / mechanism, the By funder
 * roll-up, the rail counts). Fixture grants and people are invented.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import { db } from "@/lib/db";
import {
  awardKey,
  awardSerial,
  collapseAwards,
  filterAwards,
  loadCoreGrantAwards,
  parseCoreGrantsParams,
  type AwardRow,
  type GrantRowInput,
} from "@/lib/edit/core-grants-report";

describe("awardKey", () => {
  it.each([
    ["5R01CA123456-03", "CA123456"],
    ["R01 CA123456", "CA123456"],
    ["CA-123456", "CA123456"],
    ["1UL1TR002384-01", "TR002384"],
    ["UL1 TR002384", "TR002384"],
    ["PCORI-INSIGHT", "PCORIINSIGHT"],
  ])("%s → %s", (raw, key) => {
    expect(awardKey(raw)).toBe(key);
  });
  it("null / empty → null", () => {
    expect(awardKey(null)).toBeNull();
    expect(awardKey("")).toBeNull();
    expect(awardKey("--")).toBeNull();
  });
});

function g(id: string, over: Partial<GrantRowInput> = {}): GrantRowInput {
  return {
    id,
    cwid: `c${id}`,
    name: `Person ${id}`,
    title: `Title ${id}`,
    role: "Co-I",
    funder: "NIH",
    primeSponsor: "NIH",
    mechanism: "R01",
    awardNumber: "R01CA123456",
    start: "2020-01-01",
    end: "2024-12-31",
    ...over,
  };
}

describe("collapseAwards", () => {
  const rows = [
    // Co-I row, first year of the award.
    g("a", { cwid: "zz1", start: "2019-07-01", end: "2024-06-30", awardNumber: "5R01CA123456-01" }),
    // The PI's row (a renewal-year spelling of the same award).
    g("b", {
      cwid: "pi1",
      name: "Pat PI",
      role: "PI",
      title: "Real title",
      start: "2020-07-01",
      end: "2029-06-30",
      awardNumber: "R01 CA123456",
    }),
    // A different award, no PI row.
    g("c", {
      cwid: "bb2",
      awardNumber: "R21LM013331",
      start: "2020-04-01",
      end: "2022-03-31",
      mechanism: "R21",
    }),
    g("d", {
      cwid: "aa1",
      awardNumber: "R21LM013331",
      start: "2020-04-01",
      end: "2022-03-31",
      mechanism: null,
    }),
    // An award no confirmed paper links to.
    g("e", { awardNumber: "R01HL999999" }),
  ];
  const links = [
    { grantId: "a", pmid: "1" },
    { grantId: "b", pmid: "1" },
    { grantId: "b", pmid: "2" },
    { grantId: "c", pmid: "3" },
  ];
  const awards = collapseAwards(rows, links, "2026-09-28");

  it("one row per award; unlinked awards are absent", () => {
    expect(awards.map((x) => x.key)).toEqual(["CA123456", "LM013331"]);
  });

  it("PI row wins title and PI; the period spans every row; papers are distinct", () => {
    expect(awards[0]).toMatchObject({
      piCwid: "pi1",
      piName: "Pat PI",
      title: "Real title",
      start: "2019-07-01",
      end: "2029-06-30",
      active: true,
      papers: 2,
    });
  });

  it("no PI row → the first holder (earliest start, then CWID); mechanism from any row", () => {
    expect(awards[1]).toMatchObject({ piCwid: "aa1", mechanism: "R21", active: false, papers: 1 });
  });

  it("active is inclusive of the end date", () => {
    expect(
      collapseAwards(
        [g("x", { end: "2026-09-28" })],
        [{ grantId: "x", pmid: "1" }],
        "2026-09-28",
      )[0].active,
    ).toBe(true);
    expect(
      collapseAwards(
        [g("x", { end: "2026-09-27" })],
        [{ grantId: "x", pmid: "1" }],
        "2026-09-28",
      )[0].active,
    ).toBe(false);
  });

  it("a row with no award number stands alone", () => {
    const r = collapseAwards(
      [g("x", { awardNumber: null }), g("y", { awardNumber: null })],
      [
        { grantId: "x", pmid: "1" },
        { grantId: "y", pmid: "1" },
      ],
      "2026-09-28",
    );
    expect(r).toHaveLength(2);
  });

  it("funder is primeSponsor, else funder", () => {
    const [x] = collapseAwards(
      [g("x", { primeSponsor: null, funder: "PCORI" })],
      [{ grantId: "x", pmid: "1" }],
      "2026-09-28",
    );
    expect(x.funder).toBe("PCORI");
  });
});

describe("filterAwards", () => {
  const award = (key: string, over: Partial<AwardRow>): AwardRow => ({
    key,
    awardNumber: key,
    title: key,
    piCwid: "p",
    piName: "P",
    funder: "NIH",
    mechanism: "R01",
    start: "2020-01-01",
    end: "2030-01-01",
    active: true,
    papers: 1,
    ...over,
  });
  const all = [
    award("A", { papers: 3 }),
    award("B", { active: false, mechanism: "R21" }),
    award("C", { funder: "AHRQ", mechanism: null }),
  ];
  const keys = new Map([
    ["A", new Set(["1", "2", "3"])],
    ["B", new Set(["3"])],
    ["C", new Set(["4"])],
  ]);

  it("defaults to active today", () => {
    const r = filterAwards(all, parseCoreGrantsParams(new URLSearchParams()), keys);
    expect(r.awards.map((a) => a.key)).toEqual(["A", "C"]);
    expect(r.linkedPapers).toBe(4);
    expect(r.statusCounts).toEqual({ active: 2, any: 3 });
  });

  it("funder and mechanism narrow; By funder rolls up grants and papers", () => {
    const r = filterAwards(
      all,
      parseCoreGrantsParams(new URLSearchParams("status=any&funder=NIH")),
      keys,
    );
    expect(r.awards.map((a) => a.key)).toEqual(["A", "B"]);
    expect(r.byFunder).toEqual([{ funder: "NIH", grants: 2, papers: 4 }]);
    expect(r.linkedPapers).toBe(3);
    // A funder's count ignores the funder filter itself.
    expect(r.funderOptions).toEqual([
      { value: "NIH", label: "NIH", count: 2 },
      { value: "AHRQ", label: "AHRQ", count: 1 },
    ]);
    const m = filterAwards(
      all,
      parseCoreGrantsParams(new URLSearchParams("status=any&mech=Not recorded")),
      keys,
    );
    expect(m.awards.map((a) => a.key)).toEqual(["C"]);
  });
});

describe("loadCoreGrantAwards", () => {
  const dbRow = (
    id: string,
    awardNumber: string | null,
    over: Partial<{ cwid: string; role: string; start: string; end: string }> = {},
  ) => ({
    id,
    cwid: over.cwid ?? `c${id}`,
    title: `Title ${id}`,
    role: over.role ?? "Co-I",
    funder: "NIH",
    primeSponsor: "NIH",
    mechanism: "R01",
    awardNumber,
    startDate: new Date(`${over.start ?? "2015-07-01"}T00:00:00Z`),
    endDate: new Date(`${over.end ?? "2020-06-30"}T00:00:00Z`),
    scholar: { preferredName: `Person ${id}` },
  });

  it("finds the award's other rows by award KEY, not the raw award-number string", async () => {
    // The core's paper is linked only to a Co-I's first-cycle row.
    const coi = dbRow("1", "1R01CA012345-01");
    const table = [
      coi,
      // The PI's renewal, spelled differently, still active.
      dbRow("2", "5 R01 CA012345-06", {
        cwid: "pi1",
        role: "PI",
        start: "2020-07-01",
        end: "2099-06-30",
      }),
      // Shares the serial digits but is another award (other IC): excluded.
      dbRow("3", "R01HL012345", { role: "PI", end: "2099-06-30" }),
      // Non-NIH shape, linked: fetched by its exact string.
      dbRow("4", "PCORI-INSIGHT"),
    ];
    const grantFind = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const or = where.OR as { awardNumber: { contains: string } }[] | undefined;
      if (or)
        return table.filter((r) => or.some((a) => r.awardNumber?.includes(a.awardNumber.contains)));
      const inList = (where.awardNumber as { in: string[] }).in;
      return table.filter((r) => r.awardNumber !== null && inList.includes(r.awardNumber));
    });
    const read = db.read as unknown as Record<string, unknown>;
    read.grantPublication = {
      findMany: vi.fn(async () => [
        { pmid: "100", grantId: "1", grant: coi },
        { pmid: "101", grantId: "4", grant: table[3] },
      ]),
    };
    read.grant = { findMany: grantFind };

    const { awards } = await loadCoreGrantAwards(["100", "101"], "2026-09-28");
    const ca = awards.find((a) => a.key === "CA012345")!;
    expect(ca).toMatchObject({
      piCwid: "pi1",
      start: "2015-07-01",
      end: "2099-06-30",
      active: true,
      papers: 1,
    });
    expect(awards.map((a) => a.key).sort()).toEqual(["CA012345", "PCORIINSIGHT"]);
    expect(grantFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ awardNumber: { contains: "12345" } }] } }),
    );
  });

  it("awardSerial: the serial digits, else null", () => {
    expect(awardSerial("5 R01 CA012345-06")).toBe("12345");
    expect(awardSerial("PCORI-INSIGHT")).toBeNull();
    expect(awardSerial(null)).toBeNull();
  });
});
