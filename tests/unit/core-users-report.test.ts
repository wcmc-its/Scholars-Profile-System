/**
 * Report 11 (Core users) — the pure pieces of `lib/edit/core-users-report.ts`:
 * the parser, the per-person roll-up (`buildCoreUsers`: a PMID counts once per
 * person however many authorship rows repeat it, the year window, the
 * who-filter set, known client, minimum papers, the Departments roll-up, the
 * rail counts) and the scholar-list cap (`coreUsersExportAllowed`), plus the
 * download route REFUSING (409, no file) above `SCHOLAR_EXPORT_CAP`.
 * Fixture people are invented.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  pmids: vi.fn(),
  load: vi.fn(),
  workbook: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/edit/core-report-common", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/core-report-common")>()),
  gateCoreReportDownload: h.gate,
  loadCoreConfirmedPmids: h.pmids,
}));
vi.mock("@/lib/edit/core-users-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/core-users-report")>()),
  loadCoreUsersReport: h.load,
  buildCoreUsersWorkbook: h.workbook,
}));

import { GET } from "@/app/api/edit/reports/core-users/route";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import {
  buildCoreUsers,
  coreUsersExportAllowed,
  parseCoreUsersParams,
  type CoreAuthorship,
  type CoreUserRow,
} from "@/lib/edit/core-users-report";

function a(
  cwid: string,
  pmid: string,
  year: number | null,
  over: Partial<CoreAuthorship> = {},
): CoreAuthorship {
  return {
    cwid,
    pmid,
    year,
    name: `Person ${cwid}`,
    deptCode: "MED",
    department: "Medicine",
    roleCategory: "full_time_faculty",
    ...over,
  };
}

const ANY = { client: "any", minPapers: 0, from: null, to: null } as const;

describe("parseCoreUsersParams", () => {
  it("defaults, and junk falls back", () => {
    expect(
      parseCoreUsersParams(new URLSearchParams("client=maybe&minp=3&from=abc&view=x")),
    ).toEqual({
      types: [],
      units: [],
      client: "any",
      minPapers: 0,
      from: null,
      to: null,
      view: "people",
    });
  });
  it("reads the who-filter through parsePersonFilter and swaps a reversed window", () => {
    const p = parseCoreUsersParams(
      new URLSearchParams(
        "type=postdoc&unit=dept:MED&client=yes&minp=5&from=2024&to=2019&view=departments",
      ),
    );
    expect(p).toMatchObject({
      types: ["postdoc"],
      units: ["dept:MED"],
      client: "yes",
      minPapers: 5,
      from: 2019,
      to: 2024,
      view: "departments",
    });
  });
});

describe("buildCoreUsers", () => {
  it("one row per person; a PMID repeated across authorship rows counts once", () => {
    const r = buildCoreUsers(
      [a("x1", "1", 2020), a("x1", "1", 2020), a("x1", "2", 2023), a("y2", "1", 2020)],
      {
        whoMatch: null,
        clientCwids: new Set(),
        params: ANY,
      },
    );
    expect(r.people.map((p) => [p.cwid, p.papers, p.firstYear, p.lastYear])).toEqual([
      ["x1", 2, 2020, 2023],
      ["y2", 1, 2020, 2020],
    ]);
  });

  it("the year window drops papers outside it before counting; an undated paper only counts with no window", () => {
    const rows = [a("x1", "1", 2018), a("x1", "2", 2022), a("x1", "3", null)];
    const all = buildCoreUsers(rows, { whoMatch: null, clientCwids: new Set(), params: ANY });
    expect(all.people[0].papers).toBe(3);
    const win = buildCoreUsers(rows, {
      whoMatch: null,
      clientCwids: new Set(),
      params: { ...ANY, from: 2020, to: 2024 },
    });
    expect(win.people[0]).toMatchObject({ papers: 1, firstYear: 2022, lastYear: 2022 });
  });

  it("who-filter set, known client and minimum papers each narrow; rail options stay unfiltered", () => {
    const rows = [
      a("x1", "1", 2020),
      a("x1", "2", 2021),
      a("y2", "1", 2020, { roleCategory: "postdoc", deptCode: "PED", department: "Pediatrics" }),
      a("z3", "3", 2020),
    ];
    const clients = new Set(["y2"]);
    const who = buildCoreUsers(rows, {
      whoMatch: new Set(["x1", "y2"]),
      clientCwids: clients,
      params: ANY,
    });
    expect(who.people.map((p) => p.cwid)).toEqual(["x1", "y2"]);
    expect(who.typeOptions).toEqual([
      { value: "full_time_faculty", label: expect.any(String), count: 2 },
      { value: "postdoc", label: expect.any(String), count: 1 },
    ]);
    expect(who.deptOptions).toEqual([
      { value: "dept:MED", label: "Medicine", count: 2 },
      { value: "dept:PED", label: "Pediatrics", count: 1 },
    ]);
    const known = buildCoreUsers(rows, {
      whoMatch: null,
      clientCwids: clients,
      params: { ...ANY, client: "yes" },
    });
    expect(known.people.map((p: CoreUserRow) => [p.cwid, p.knownClient])).toEqual([["y2", true]]);
    const notKnown = buildCoreUsers(rows, {
      whoMatch: null,
      clientCwids: clients,
      params: { ...ANY, client: "no" },
    });
    expect(notKnown.people.map((p) => p.cwid)).toEqual(["x1", "z3"]);
    const twoPlus = buildCoreUsers(rows, {
      whoMatch: null,
      clientCwids: clients,
      params: { ...ANY, minPapers: 2 },
    });
    expect(twoPlus.people.map((p) => p.cwid)).toEqual(["x1"]);
  });

  it("known client matches case-insensitively (lowercased client set vs a mixed-case scholar cwid)", () => {
    const rows = [a("ABC1001", "1", 2020), a("x1", "2", 2020)];
    const clients = new Set(["abc1001"]);
    const yes = buildCoreUsers(rows, {
      whoMatch: null,
      clientCwids: clients,
      params: { ...ANY, client: "yes" },
    });
    expect(yes.people.map((p) => [p.cwid, p.knownClient])).toEqual([["ABC1001", true]]);
    const no = buildCoreUsers(rows, {
      whoMatch: null,
      clientCwids: clients,
      params: { ...ANY, client: "no" },
    });
    expect(no.people.map((p) => p.cwid)).toEqual(["x1"]);
  });

  it("an empty who-match set matches nobody (never everyone)", () => {
    const r = buildCoreUsers([a("x1", "1", 2020)], {
      whoMatch: new Set(),
      clientCwids: new Set(),
      params: ANY,
    });
    expect(r.people).toEqual([]);
  });

  it("Departments rolls up the listed people: people and summed papers, a missing department named", () => {
    const r = buildCoreUsers(
      [
        a("x1", "1", 2020),
        a("x1", "2", 2020),
        a("y2", "1", 2020),
        a("z3", "4", 2020, { deptCode: null, department: null }),
      ],
      { whoMatch: null, clientCwids: new Set(), params: ANY },
    );
    expect(r.departments).toEqual([
      { department: "Medicine", people: 2, papers: 3 },
      { department: "No department on record", people: 1, papers: 1 },
    ]);
  });
});

describe("scholar-list cap", () => {
  it("offers the download at the cap, refuses one over it", () => {
    expect(SCHOLAR_EXPORT_CAP).toBe(50);
    expect(coreUsersExportAllowed(50)).toBe(true);
    expect(coreUsersExportAllowed(51)).toBe(false);
  });

  const people = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ cwid: `p${i}`, name: `P${i}`, papers: 1 }));
  const req = (qs: string) =>
    ({
      nextUrl: new URL(`http://x/api/edit/reports/core-users?${qs}`),
    }) as unknown as import("next/server").NextRequest;

  it("the route refuses (409, no workbook) above the cap", async () => {
    h.gate.mockResolvedValue({
      ok: true,
      coreId: "14",
      ctx: { unit: { name: "Core" } },
      session: {},
    });
    h.pmids.mockResolvedValue(["1"]);
    h.load.mockResolvedValue({
      people: people(51),
      departments: [],
      typeOptions: [],
      deptOptions: [],
    });
    const res = await GET(req("center=14&kind=core"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "over_scholar_export_cap" });
    expect(h.workbook).not.toHaveBeenCalled();
  });

  it("the route sends the whole list at the cap", async () => {
    h.load.mockResolvedValue({
      people: people(50),
      departments: [],
      typeOptions: [],
      deptOptions: [],
    });
    h.workbook.mockResolvedValue(Buffer.from("xlsx"));
    const res = await GET(req("center=14&kind=core"));
    expect(res.status).toBe(200);
    expect(h.workbook).toHaveBeenCalledTimes(1);
    expect(h.workbook.mock.calls[0][2].people).toHaveLength(50);
  });
});
