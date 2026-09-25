/**
 * Report 2 (NCI Table 2a) — the db-free helpers in `lib/edit/nci-2a-report.ts`:
 * review status, URL params, filter + sort, headline numbers (a not-inferred
 * row is left out of the Cancer-relevant figure and the label says so), the
 * download note, chips, and the CSV (Review Status column, never a CWID).
 * Fixture people and awards are invented.
 */
import { describe, expect, it } from "vitest";

import {
  applyNci2aWrite,
  filterNci2a,
  NCI2A_CSV_HEADER,
  nci2aCsvFilename,
  nci2aFiltered,
  nci2aHref,
  nci2aUnitQuery,
  nci2aWriteLanded,
  nci2aChips,
  nci2aCsv,
  nci2aDownloadNote,
  nci2aQueryString,
  nci2aStatTiles,
  nci2aStats,
  nci2aStatus,
  bulkAcceptTargets,
  NCI2A_ACCEPT_CAP,
  parseNci2aParams,
  reviewProgress,
  statusPillLabel,
  sortQuery,
  type Nci2aAward,
} from "@/lib/edit/nci-2a-report";
import { REPORT_META_DEFAULTS } from "@/lib/edit/report-meta";

function award(over: Partial<Nci2aAward> & { id: string }): Nci2aAward {
  const pct = over.cancerRelevantPercent === undefined ? 50 : over.cancerRelevantPercent;
  const dc = over.annualProjectDirectCosts ?? 100000;
  return {
    pi: `Testperson, ${over.id}`,
    specificFundingSource: "National Cancer Institute",
    projectNumber: `5 R01 CA${over.id}`,
    projectTitle: `Project ${over.id}`,
    projectStartDate: "2024-01-01",
    projectEndDate: "2028-12-31",
    annualProjectDirectCosts: dc,
    cancerRelevantPercentSource: "llm",
    // The AI original defaults to the fixture's percent (so a human row is Confirmed).
    cancerRelevantPercentAi: pct,
    cancerRelevantRationale: null,
    cancerRelevantAnnualProjectDc: pct == null ? null : (dc * pct) / 100,
    isPeerReviewed: true,
    grantCwid: `zzz${over.id}`,
    applId: null,
    programFrom: "membership",
    allocations: [
      {
        id: `al-${over.id}`,
        programCode: "CB",
        programLabel: "Cancer Biology",
        programPercent: 100,
        source: "membership",
        annualProgramDirectCosts: null,
      },
    ],
    ...over,
    cancerRelevantPercent: pct,
  };
}

const params = (q = "") => parseNci2aParams(new URLSearchParams(q));

const A = award({
  id: "1",
  pi: "Alpha, Ann",
  annualProjectDirectCosts: 200000,
  cancerRelevantPercent: 50,
});
const B = award({
  id: "2",
  pi: "Beta, Bob",
  cancerRelevantPercentSource: "human",
  cancerRelevantPercent: 100,
  isPeerReviewed: false,
  allocations: [],
  programFrom: "stored",
});
const C = award({
  id: "3",
  pi: "Gamma, Cy",
  cancerRelevantPercent: null,
  annualProjectDirectCosts: 300000,
});
const ALL = [A, B, C];

describe("nci2aStatus", () => {
  it("human → confirmed, llm → ai, a null percent → not-inferred", () => {
    expect(nci2aStatus(B)).toBe("confirmed");
    expect(nci2aStatus(A)).toBe("ai");
    expect(nci2aStatus(C)).toBe("not-inferred");
  });

  it("human + a different AI value → corrected; equal or no AI value → confirmed", () => {
    const corrected = { ...B, cancerRelevantPercentAi: 60 };
    expect(nci2aStatus(corrected)).toBe("corrected");
    expect(statusPillLabel(corrected)).toBe("Corrected · AI said 60%");
    expect(nci2aStatus({ ...B, cancerRelevantPercentAi: 100 })).toBe("confirmed");
    expect(nci2aStatus({ ...B, cancerRelevantPercentAi: null })).toBe("confirmed");
    expect(statusPillLabel(B)).toBe("Confirmed");
    expect(statusPillLabel(A)).toBe("AI-suggested");
    expect(statusPillLabel(C)).toBe("Not inferred");
    // An llm row whose AI value differs (shouldn't happen) is still just AI-suggested.
    expect(nci2aStatus({ ...A, cancerRelevantPercentAi: 10 })).toBe("ai");
  });

  it("a corrected row is reviewed: out of Needs review", () => {
    const corrected = { ...B, cancerRelevantPercentAi: 60 };
    expect(filterNci2a([A, corrected, C], params()).counts).toEqual({ all: 3, needs: 2, done: 1 });
  });
});

describe("params", () => {
  it("defaults, and ignores values it doesn't know", () => {
    expect(params()).toEqual({
      status: "all",
      program: "",
      peer: "",
      q: "",
      sort: "pi",
      dir: "asc",
    });
    expect(params("status=bogus&peer=maybe&sort=x")).toEqual(params());
    expect(params("sort=dc").dir).toBe("desc");
  });

  it("round-trips, leaving defaults out", () => {
    expect(nci2aQueryString(params())).toBe("");
    const p = params("status=needs&program=CB&peer=yes&q=lung&sort=rel&dir=asc");
    expect(parseNci2aParams(new URLSearchParams(nci2aQueryString(p)))).toEqual(p);
  });

  it("a header click flips the current column and starts a new one at its first direction", () => {
    expect(sortQuery(params(), "pi")).toBe("sort=pi&dir=desc");
    expect(sortQuery(params(), "dc")).toBe("sort=dc&dir=desc");
    expect(sortQuery(params("sort=dc&dir=desc"), "dc")).toBe("sort=dc&dir=asc");
  });
});

describe("filterNci2a", () => {
  it("counts segments over the other filters; not-inferred counts as Needs review", () => {
    const r = filterNci2a(ALL, params());
    expect(r.counts).toEqual({ all: 3, needs: 2, done: 1 });
    expect(filterNci2a(ALL, params("status=needs")).rows.map((a) => a.id)).toEqual(["1", "3"]);
    expect(filterNci2a(ALL, params("status=done")).rows.map((a) => a.id)).toEqual(["2"]);
  });

  it("program, unassigned, peer-reviewed and search (PI, CWID, funder, number, title)", () => {
    expect(filterNci2a(ALL, params("program=CB")).rows.map((a) => a.id)).toEqual(["1", "3"]);
    expect(filterNci2a(ALL, params("program=none")).rows.map((a) => a.id)).toEqual(["2"]);
    expect(filterNci2a(ALL, params("peer=no")).rows.map((a) => a.id)).toEqual(["2"]);
    expect(filterNci2a(ALL, params("q=zzz3")).rows.map((a) => a.id)).toEqual(["3"]);
    expect(filterNci2a(ALL, params("q=beta project")).rows.map((a) => a.id)).toEqual(["2"]);
    expect(filterNci2a(ALL, params("peer=yes&status=needs")).counts).toEqual({
      all: 2,
      needs: 2,
      done: 0,
    });
  });

  it("sorts; a null percent sorts last either way", () => {
    expect(filterNci2a(ALL, params("sort=pct&dir=desc")).rows.map((a) => a.id)).toEqual([
      "2",
      "1",
      "3",
    ]);
    expect(filterNci2a(ALL, params("sort=pct&dir=asc")).rows.map((a) => a.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(filterNci2a(ALL, params("sort=dc&dir=desc")).rows.map((a) => a.id)).toEqual([
      "3",
      "1",
      "2",
    ]);
    expect(filterNci2a(ALL, params("sort=pi&dir=desc")).rows.map((a) => a.id)).toEqual([
      "3",
      "2",
      "1",
    ]);
  });
});

describe("numbers", () => {
  it("leaves not-inferred rows out of the Cancer-relevant figure and says so", () => {
    const s = nci2aStats(ALL);
    expect(s).toMatchObject({
      projects: 3,
      directCosts: 600000,
      relevant: 200000,
      inferredDirectCosts: 300000,
      notInferred: 1,
      needsReview: 2,
    });
    expect(nci2aStatTiles(s)).toEqual([
      { value: "$600,000", label: "Direct costs, 3 projects" },
      { value: "$200,000", label: "Cancer-relevant (67%; excludes 1 not inferred)" },
      { value: "83%", label: "Peer-reviewed funding" },
    ]);
    expect(nci2aStatTiles(nci2aStats([A]))[1].label).toBe("Cancer-relevant (50%)");
    expect(
      nci2aStatTiles(nci2aStats([award({ id: "9", annualProjectDirectCosts: 2_500_000 })]))[0]
        .value,
    ).toBe("$2.5M");
  });

  it("progress counts reviewed rows of those with an AI value, cycle-wide", () => {
    // C has no AI value (not inferred), so it is out of the denominator.
    // needsReview counts every row still to review, the not-inferred C included.
    expect(reviewProgress(ALL)).toEqual({
      reviewed: 1,
      total: 2,
      pending: 1,
      needsReview: 2,
      pct: 50,
    });
    // A corrected row counts as reviewed; a human value on a row with no AI value doesn't count.
    const corrected = {
      ...A,
      cancerRelevantPercentSource: "human" as const,
      cancerRelevantPercent: 10,
    };
    const humanNoAi = {
      ...C,
      cancerRelevantPercentSource: "human" as const,
      cancerRelevantPercent: 5,
    };
    expect(reviewProgress([corrected, B, humanNoAi])).toEqual({
      reviewed: 2,
      total: 2,
      pending: 0,
      needsReview: 0,
      pct: 100,
    });
    // Every AI row reviewed, one not-inferred left: progress is 100% but the
    // review link still has a row to point at.
    expect(reviewProgress([corrected, B, C])).toMatchObject({
      pending: 0,
      needsReview: 1,
      pct: 100,
    });
    expect(reviewProgress([]).pct).toBe(100);
  });

  it("the download note flags pending rows, or says all are reviewed", () => {
    expect(nci2aDownloadNote("osra-2026-07-14", nci2aStats(ALL))).toEqual({
      text: "Cycle osra-2026-07-14 · annual figures. 2 rows still need review and are flagged in the file.",
      pending: true,
    });
    expect(nci2aDownloadNote("osra-2026-07-14", nci2aStats([B])).pending).toBe(false);
  });

  it("chips for program, peer and search, each removing only itself", () => {
    const p = params("status=needs&program=CB&peer=no&q=lung");
    expect(nci2aChips(p, [{ code: "CB", label: "Cancer Biology" }])).toEqual([
      { group: "Program", value: "Cancer Biology", removeQuery: "status=needs&peer=no&q=lung" },
      { group: "Peer-reviewed", value: "No", removeQuery: "status=needs&program=CB&q=lung" },
      { group: "Search", value: "lung", removeQuery: "status=needs&program=CB&peer=no" },
    ]);
    expect(nci2aChips(params(), [])).toEqual([]);
  });
});

describe("nci2aCsv", () => {
  it("has a Review Status column and no CWID anywhere", () => {
    const csv = nci2aCsv(ALL);
    const [header, ...lines] = csv.split("\n");
    expect(header.split(",")).toEqual([...NCI2A_CSV_HEADER]);
    expect(header.toLowerCase()).not.toContain("cwid");
    for (const a of ALL) expect(csv).not.toContain(a.grantCwid as string);
    const col = NCI2A_CSV_HEADER.indexOf("Review Status");
    expect(lines.map((l) => l.split(",")[col + 1])).toEqual([
      "Needs review",
      "Confirmed",
      "Needs review",
    ]);
    const corrected = nci2aCsv([{ ...B, cancerRelevantPercentAi: 60 }]).split("\n")[1];
    expect(corrected.split(",")[col + 1]).toBe("Corrected");
  });

  it("bulk Accept targets the AI-suggested rows shown, in order, capped", () => {
    expect(bulkAcceptTargets(ALL).map((a) => a.id)).toEqual(["1"]);
    const many = Array.from({ length: 60 }, (_, i) => award({ id: String(i) }));
    expect(NCI2A_ACCEPT_CAP).toBe(50);
    expect(bulkAcceptTargets([B, ...many]).map((a) => a.id)).toEqual(
      many.slice(0, 50).map((a) => a.id),
    );
  });

  it("an award with no allocation still gets its line; a split repeats program lines only", () => {
    const split = award({
      id: "4",
      pi: 'Quote, "Q"',
      allocations: [
        {
          id: "x",
          programCode: "CB",
          programLabel: "CB",
          programPercent: 60,
          source: "human",
          annualProgramDirectCosts: 30000,
        },
        {
          id: "y",
          programCode: "CT",
          programLabel: "CT",
          programPercent: 40,
          source: "human",
          annualProgramDirectCosts: 20000,
        },
      ],
    });
    const lines = nci2aCsv([B, split]).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1].startsWith('"Beta, Bob"')).toBe(true);
    expect(lines[2].startsWith('"Quote, ""Q"""')).toBe(true);
    expect(lines[3]).toBe(",,,,,,,,,,,CT,40,20000");
  });
});

describe("unit in links", () => {
  it("every link carries center (and kind off a center) before the filters", () => {
    expect(nci2aUnitQuery("ctsc", "center")).toBe("center=ctsc");
    expect(nci2aUnitQuery("x y", "core")).toBe("center=x+y&kind=core");
    expect(nci2aHref("/r", "center=ctsc", "")).toBe("/r?center=ctsc");
    expect(nci2aHref("/r", "center=ctsc", "status=needs")).toBe("/r?center=ctsc&status=needs");
  });
});

describe("a filtered download says so", () => {
  it("any filter, status included, marks the file and the note", () => {
    expect(nci2aFiltered(parseNci2aParams(new URLSearchParams()))).toBe(false);
    expect(nci2aFiltered(parseNci2aParams(new URLSearchParams("sort=dc&dir=asc")))).toBe(false);
    for (const q of ["status=needs", "program=CB", "peer=no", "q=lung"])
      expect(nci2aFiltered(parseNci2aParams(new URLSearchParams(q)))).toBe(true);
    expect(nci2aCsvFilename("osra-2026-07-14", false)).toBe("nci-table-2a-osra-2026-07-14.csv");
    expect(nci2aCsvFilename("osra-2026-07-14", true)).toBe(
      "nci-table-2a-osra-2026-07-14-filtered.csv",
    );
    const s = nci2aStats([award({ id: "1", cancerRelevantPercentSource: "human" })]);
    expect(nci2aDownloadNote("c", s, true).text).toBe(
      "Cycle c · annual figures. Filtered: this file holds only the 1 project these filters select, not the whole cycle. Every percentage in this file has been reviewed.",
    );
    expect(nci2aDownloadNote("c", s).text).not.toContain("Filtered");
  });
});

describe("applyNci2aWrite", () => {
  it("shows the written percent as reviewed with its dollars, until the server row has it", () => {
    const a = award({ id: "1", cancerRelevantPercent: 40, annualProjectDirectCosts: 1000 });
    const split = {
      ...a,
      allocations: [
        { ...a.allocations[0], programPercent: 60 },
        { ...a.allocations[0], id: "b", programCode: "CT", programPercent: 40 },
      ],
    };
    expect(nci2aStatus(applyNci2aWrite(split, 40))).toBe("confirmed");
    const w = applyNci2aWrite(split, 37.5);
    expect(nci2aStatus(w)).toBe("corrected");
    expect(w.cancerRelevantPercent).toBe(37.5);
    expect(w.cancerRelevantAnnualProjectDc).toBe(375);
    expect(w.allocations.map((al) => al.annualProgramDirectCosts)).toEqual([225, 150]);
    expect(nci2aWriteLanded(a, 65)).toBe(false);
    expect(nci2aWriteLanded({ ...a, cancerRelevantPercentSource: "human" }, 40)).toBe(true);
    // The AI original survives the write: a different value reads as Corrected.
    const c = applyNci2aWrite(a, 65);
    expect(c.cancerRelevantPercentAi).toBe(40);
    expect(nci2aStatus(c)).toBe("corrected");
  });
});

describe("report 2 summary", () => {
  it("no longer offers program allocation (Program is read-only)", () => {
    expect(REPORT_META_DEFAULTS["2"].summary).not.toMatch(/allocation/i);
    expect(REPORT_META_DEFAULTS["2"].summary).toContain("center membership");
  });
});
