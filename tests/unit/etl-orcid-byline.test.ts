/**
 * Byline evidence for the ORCID queue (`etl/orcid-evidence/byline.ts` and its place in
 * `bandOf` / `assembleEvidence`): the accepted papers that print a candidate iD next to
 * the scholar's own name. Synthetic ids only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sources/reciterdb", () => ({
  withReciterConnection: (fn: (c: { query: typeof query }) => unknown) => fn({ query }),
  closeReciterPool: vi.fn(),
}));

import {
  bylineFactsOf,
  heldByOrcid,
  indexBylines,
  type BylineRow,
} from "@/etl/orcid-evidence/byline";
import {
  assembleEvidence,
  bandOf,
  bylineBandShift,
  bylineCrossrefShift,
  historyBandShift,
  isBylineBandEnabled,
  isBylineCrossrefEnabled,
  loadBylineRows,
  loadCrossrefBylineRows,
  recordFacts,
  SHARED_DETAIL_CAP,
  withSharedPaperDetail,
  type BandInput,
} from "@/etl/orcid-evidence/index";
import { indexScholarWorks } from "@/etl/orcid-registry/index";
import type { RecordResponse } from "@/etl/orcid-registry/orcid-api";
import { bylineBandPapers } from "@/lib/edit/orcid-queue";

const ORCID = "0000-0002-1825-0097";
const OTHER = "0000-0002-1825-009X";
const PRIMARY = "0000-0000-0000-001X";

const row = (
  cwid: string,
  pmid: string,
  orcid = ORCID,
  assertion: BylineRow["assertion"] = "ACCEPTED",
  source: BylineRow["source"] = "pubmed",
): BylineRow => ({ cwid, pmid, orcid, assertion, source });
const xrow = (...[cwid, pmid, orcid, assertion]: Parameters<typeof row>) =>
  row(cwid, pmid, orcid, assertion, "crossref");
/** Papers PubMed alone prints the iD on. */
const pm = (...pmids: string[]) => pmids.map((pmid) => ({ pmid, sources: ["pubmed"] }));

const factsFor = (rows: BylineRow[], opts: Parameters<typeof indexBylines>[1] = {}, held?: string[]) =>
  bylineFactsOf(indexBylines(rows, opts), "jd0001", ORCID, held);

describe("byline facts", () => {
  it("lists the accepted papers once each, newest first, whatever the cwid's case", () => {
    expect(factsFor([row("JD0001", "101"), row("jd0001", "101"), row("jd0001", "205")])).toEqual({
      papers: pm("205", "101"),
      rejected: 0,
      otherHolders: [],
      otherIds: [],
    });
  });

  it("pending papers are neither for nor against; a rejected one is counted", () => {
    const f = factsFor([
      row("jd0001", "101"),
      row("jd0001", "102", ORCID, "PENDING"),
      row("jd0001", "103", ORCID, "REJECTED"),
    ]);
    expect(f).toMatchObject({ papers: pm("101"), rejected: 1 });
  });

  it("two rows for one paper: REJECTED beats ACCEPTED, in either order", () => {
    for (const rows of [
      [row("jd0001", "101", ORCID, "REJECTED"), row("JD0001", "101")],
      [row("JD0001", "101"), row("jd0001", "101", ORCID, "REJECTED")],
    ])
      expect(factsFor(rows)).toMatchObject({ papers: [], rejected: 1 });
    expect(factsFor([row("jd0001", "101", ORCID, "PENDING"), row("jd0001", "101")])).toMatchObject({
      papers: pm("101"),
      rejected: 0,
    });
  });

  it("another person's accepted byline is a rival; their pending one is not", () => {
    expect(factsFor([row("jd0001", "101"), row("xy0002", "300")]).otherHolders).toEqual(["xy0002"]);
    expect(
      factsFor([row("jd0001", "101"), row("xy0002", "300", ORCID, "PENDING")]).otherHolders,
    ).toEqual([]);
  });

  it("someone else with the iD on file is a rival; the scholar is not their own", () => {
    expect(factsFor([row("jd0001", "101")], {}, ["XY0002", "jd0001"]).otherHolders).toEqual([
      "xy0002",
    ]);
  });

  it("a second iD on the scholar's accepted bylines is listed", () => {
    expect(factsFor([row("jd0001", "101"), row("jd0001", "102", OTHER)]).otherIds).toEqual([OTHER]);
    expect(
      factsFor([row("jd0001", "101"), row("jd0001", "102", OTHER, "REJECTED")]).otherIds,
    ).toEqual([]);
  });

  it("other institutions' cohorts and ruled-out pairs are left out", () => {
    const f = factsFor(
      [
        row("jd0001", "101"),
        row("ucsf_123", "300"),
        row("xy0002", "301"),
        row("jd0001", "102", OTHER),
      ],
      { dismissed: new Set([`xy0002|${ORCID}`, `jd0001|${OTHER}`]) },
    );
    expect(f).toEqual({ papers: pm("101"), rejected: 0, otherHolders: [], otherIds: [] });
  });

  it("a deprecated iD counts as its primary, so it is no second iD", () => {
    const index = indexBylines([row("jd0001", "101"), row("jd0001", "102", PRIMARY)], {
      deprecated: new Map([[ORCID, PRIMARY]]),
    });
    expect(bylineFactsOf(index, "jd0001", PRIMARY)).toMatchObject({
      papers: pm("102", "101"),
      otherIds: [],
    });
  });

  it("ruling out a deprecated iD rules its papers out of the primary too", () => {
    const index = indexBylines([row("jd0001", "101"), row("jd0001", "102", PRIMARY)], {
      deprecated: new Map([[ORCID, PRIMARY]]),
      dismissed: new Set([`jd0001|${ORCID}`]),
    });
    expect(bylineFactsOf(index, "jd0001", PRIMARY).papers).toEqual(pm("102"));
  });

  it("heldByOrcid: live scholars only, a deprecated iD on file held as its primary", () => {
    expect(
      heldByOrcid(
        [
          { cwid: "xy0002", orcid: ORCID, deletedAt: null },
          { cwid: "zz0003", orcid: PRIMARY, deletedAt: null },
          { cwid: "gone01", orcid: OTHER, deletedAt: new Date(0) },
          { cwid: "none01", orcid: null, deletedAt: null },
        ],
        new Map([[ORCID, PRIMARY]]),
      ),
    ).toEqual(new Map([[PRIMARY, ["xy0002", "zz0003"]]]));
  });

  it("a pair with no byline rows has no papers", () => {
    expect(factsFor([])).toEqual({ papers: [], rejected: 0, otherHolders: [], otherIds: [] });
  });

  it("one paper, one vote: PubMed and Crossref print the same iD on it", () => {
    for (const rows of [
      [row("jd0001", "101"), xrow("JD0001", "101"), xrow("jd0001", "101"), xrow("jd0001", "102")],
      [row("jd0001", "101"), xrow("jd0001", "102"), xrow("JD0001", "101")],
    ])
      expect(factsFor(rows).papers).toEqual([
        { pmid: "102", sources: ["crossref"] },
        { pmid: "101", sources: ["pubmed", "crossref"] },
      ]);
  });

  it("a Crossref row on a paper rejected elsewhere: REJECTED still wins", () => {
    expect(factsFor([row("jd0001", "101", ORCID, "REJECTED"), xrow("jd0001", "101")])).toMatchObject({
      papers: [],
      rejected: 1,
    });
  });

  it("PubMed and Crossref print different iDs on one slot: each is the other's second iD", () => {
    const index = indexBylines([
      row("jd0001", "101"),
      row("jd0001", "102"),
      xrow("jd0001", "101", OTHER),
      xrow("jd0001", "103", OTHER),
    ]);
    for (const [orcid, other] of [
      [ORCID, OTHER],
      [OTHER, ORCID],
    ] as const) {
      const f = bylineFactsOf(index, "jd0001", orcid);
      expect(f.papers).toHaveLength(2);
      expect(f.otherIds).toEqual([other]);
      expect(bylineBandPapers({ ...f, total: f.papers.length })).toBe(0);
    }
  });

  it("a Crossref iD the librarian ruled out, or deprecated into the other, is no conflict", () => {
    const rows = [row("jd0001", "101"), xrow("jd0001", "101", OTHER)];
    expect(factsFor(rows, { dismissed: new Set([`jd0001|${OTHER}`]) }).otherIds).toEqual([]);
    expect(factsFor(rows, { deprecated: new Map([[OTHER, ORCID]]) })).toMatchObject({
      papers: [{ pmid: "101", sources: ["pubmed", "crossref"] }],
      otherIds: [],
    });
  });

  it("bylineBandPapers: all of them, or none when anything points the other way", () => {
    const clean = { total: 3, rejected: 0, otherHolders: [], otherIds: [] };
    expect(bylineBandPapers(clean)).toBe(3);
    expect(bylineBandPapers({ ...clean, rejected: 1 })).toBe(0);
    expect(bylineBandPapers({ ...clean, otherHolders: ["xy0002"] })).toBe(0);
    expect(bylineBandPapers({ ...clean, otherIds: [OTHER] })).toBe(0);
    expect(bylineBandPapers(undefined)).toBe(0);
  });
});

describe("bandOf with byline papers", () => {
  const base: BandInput = {
    emailVerified: false,
    instMatch: false,
    shared: 0,
    competitor: false,
    nameAgrees: true,
  };

  it("two are Strong, one is Moderate, none changes nothing", () => {
    expect(bandOf(base)).toBe("weak");
    expect(bandOf({ ...base, byline: 0 })).toBe("weak");
    expect(bandOf({ ...base, byline: 1 })).toBe("moderate");
    expect(bandOf({ ...base, byline: 2 })).toBe("strong");
    expect(bandOf({ ...base, shared: 3, byline: 1 })).toBe("shared_only");
    expect(bandOf({ ...base, shared: 3, byline: 2 })).toBe("strong");
  });

  it("never with a competitor or a name that differs, and never above Email verified", () => {
    expect(bandOf({ ...base, competitor: true, byline: 5 })).toBe("weak");
    expect(bandOf({ ...base, nameAgrees: false, byline: 5 })).toBe("weak");
    expect(bandOf({ ...base, emailVerified: true, byline: 5 })).toBe("email_verified");
  });
});

describe("assembleEvidence with byline papers", () => {
  /** A public record that shows a name and nothing else. */
  const empty = (family = "Doe"): RecordResponse => ({
    history: { "last-modified-date": { value: Date.UTC(2026, 9, 1) } },
    person: {
      name: {
        "given-names": { value: "Jane" },
        "family-name": { value: family },
        "credit-name": null,
      },
      "other-names": { "other-name": [] },
      emails: { email: [] },
    },
    "activities-summary": {
      "last-modified-date": null,
      employments: { "affiliation-group": [] },
      educations: { "affiliation-group": [] },
      works: { "last-modified-date": null, group: [] },
    },
  });
  const JANE = { cwid: "jd0001", fullName: "Jane Doe", preferredName: "Jane Doe", email: null };
  const run = (
    rows: BylineRow[] | null,
    over: {
      on?: boolean;
      family?: string;
      heldBy?: Map<string, string[]>;
      crossref?: BylineRow[];
      crossrefOn?: boolean;
    } = {},
  ) =>
    assembleEvidence({
      pairs: [{ cwid: "jd0001", orcid: ORCID }],
      onFile: new Set(),
      facts: new Map([[ORCID, recordFacts(ORCID, empty(over.family))]]),
      scholars: new Map([["jd0001", JANE]]),
      works: indexScholarWorks([{ cwid: "jd0001", pmid: "101", doi: "10.1/a" }]),
      active: [JANE],
      sources: new Map([[`jd0001|${ORCID}`, ["rpm_inferred"]]]),
      bylines: rows ? indexBylines(rows) : undefined,
      heldBy: over.heldBy,
      bylineBand: over.on ?? true,
      bylinesWithCrossref: over.crossref && indexBylines([...(rows ?? []), ...over.crossref]),
      bylineCrossref: over.crossrefOn,
    });

  it("an empty record with one byline paper: the paper is listed, and the match is Moderate", () => {
    const rows = run([row("jd0001", "101")]);
    expect(rows[0]).toMatchObject({ band: "moderate", shared: 0, worksTotal: 0 });
    expect(rows[0]!.evidenceDetail.byline).toEqual({
      papers: [
        { pmid: "101", doi: null, title: null, year: null, journal: null, sources: ["pubmed"] },
      ],
      total: 1,
      rejected: 0,
      otherHolders: [],
      otherIds: [],
    });
    expect(run([row("jd0001", "101"), row("jd0001", "102")])[0]!.band).toBe("strong");
  });

  it("flag off: the papers are listed, the band does not move, and the run can count the moves", () => {
    const rows = run([row("jd0001", "101"), row("jd0001", "102")], { on: false });
    expect(rows[0]!.band).toBe("weak");
    expect(rows[0]!.evidenceDetail.byline?.total).toBe(2);
    expect(bylineBandShift(rows, false)).toEqual({ "weak->strong": 1 });
    // The same count with the flag on.
    expect(bylineBandShift(run([row("jd0001", "101"), row("jd0001", "102")]), false)).toEqual({
      "weak->strong": 1,
    });
  });

  it.each([
    ["a rejected paper carries the iD", [row("jd0001", "103", ORCID, "REJECTED")]],
    ["another person's accepted byline does", [row("xy0002", "300")]],
    ["the scholar's bylines carry a second iD", [row("jd0001", "104", OTHER)]],
  ] as Array<[string, BylineRow[]]>)("contested (%s): listed, never lifted", (_, extra) => {
    const rows = run([row("jd0001", "101"), row("jd0001", "102"), ...extra]);
    expect(rows[0]!.band).toBe("weak");
    expect(rows[0]!.evidenceDetail.byline?.total).toBe(2);
    expect(bylineBandShift(rows, false)).toEqual({});
  });

  it("the iD on file for another scholar: listed, never lifted", () => {
    const rows = run([row("jd0001", "101"), row("jd0001", "102")], {
      heldBy: new Map([[ORCID, ["xy0002"]]]),
    });
    expect(rows[0]).toMatchObject({ band: "weak" });
    expect(rows[0]!.evidenceDetail.byline?.otherHolders).toEqual(["xy0002"]);
  });

  it("a surname that differs on the record is never lifted", () => {
    const rows = run([row("jd0001", "101"), row("jd0001", "102")], { family: "Quimby" });
    expect(rows[0]).toMatchObject({ band: "weak", nameAgrees: false });
  });

  it("an Affiliation Manager pair is Strong already: the byline papers move nothing", () => {
    const rows = run([row("jd0001", "101"), row("jd0001", "102")], { on: false });
    rows[0]!.evidenceDetail.sources = ["cornell_affiliation_manager"];
    expect(bylineBandShift(rows, false)).toEqual({});
  });

  it("historyBandShift counts only the moves history makes beyond the byline papers", () => {
    const rows = run([row("jd0001", "101"), row("jd0001", "102")]).map((r) => ({
      ...r,
      historyMatch: true,
    }));
    expect(historyBandShift(rows)).toEqual({ "weak->moderate": 1 });
    expect(historyBandShift(rows, true)).toEqual({});
  });

  it("more papers than the cap: the list is cut, the total is not", () => {
    const many = Array.from({ length: SHARED_DETAIL_CAP + 5 }, (_, i) =>
      row("jd0001", String(1000 + i)),
    );
    const b = run(many)[0]!.evidenceDetail.byline!;
    expect(b.papers).toHaveLength(SHARED_DETAIL_CAP);
    expect(b.papers[0]!.pmid).toBe(String(1000 + SHARED_DETAIL_CAP + 4));
    expect(b.total).toBe(SHARED_DETAIL_CAP + 5);
  });

  it("reciterdb unreadable: no byline key, the row still written", () => {
    const rows = run(null);
    expect(rows[0]!.band).toBe("weak");
    expect(rows[0]!.evidenceDetail).not.toHaveProperty("byline");
  });

  describe("Crossref rows", () => {
    const shift = (rows: BylineRow[], crossref: BylineRow[], heldBy?: Map<string, string[]>) =>
      bylineCrossrefShift(
        run(rows, { crossref, crossrefOn: true, heldBy }),
        {
          bylines: indexBylines(rows),
          bylinesWithCrossref: indexBylines([...rows, ...crossref]),
          heldBy,
        },
        false,
      );
    const P1 = [row("jd0001", "101")];
    const P2 = [...P1, row("jd0001", "102")];
    const X3 = [xrow("jd0001", "103")];

    it("on: a paper in each is Strong, the sources are named, nothing is left uncounted", () => {
      const r = run(P1, { crossref: [...X3, xrow("jd0001", "101")], crossrefOn: true })[0]!;
      expect(r.band).toBe("strong");
      expect(r.evidenceDetail.byline).toMatchObject({
        total: 2,
        papers: [
          { pmid: "103", sources: ["crossref"] },
          { pmid: "101", sources: ["pubmed", "crossref"] },
        ],
      });
      expect(r.evidenceDetail.byline).not.toHaveProperty("uncounted");
      expect(shift(P1, X3)).toEqual({ "moderate->strong": 1 });
      expect(run([], { crossref: X3, crossrefOn: true })[0]!.band).toBe("moderate");
    });

    it("on, but ORCID_BYLINE_BAND off: the band does not move", () => {
      expect(run(P1, { on: false, crossref: X3, crossrefOn: true })[0]!.band).toBe("weak");
    });

    it.each([
      ["more papers", X3],
      ["a paper PubMed has too", [xrow("jd0001", "101")]],
      ["a rejected paper", [xrow("jd0001", "103", ORCID, "REJECTED")]],
      ["another person's byline", [xrow("xy0002", "300")]],
      ["a second iD", [xrow("jd0001", "103", OTHER)]],
      ["a different iD on PubMed's own paper", [xrow("jd0001", "101", OTHER)]],
      ["a rejection of PubMed's own paper", [xrow("jd0001", "101", ORCID, "REJECTED")]],
    ] as Array<[string, BylineRow[]]>)("off (%s): band, contest and moves are PubMed's alone", (_, crossref) => {
      for (const rows of [[], P1, P2]) {
        const [alone] = run(rows);
        const [off] = run(rows, { crossref });
        const alike = { papers: [], uncounted: undefined, uncountedContests: undefined };
        expect({ ...off!.evidenceDetail.byline!, ...alike }).toEqual({
          ...alone!.evidenceDetail.byline!,
          ...alike,
        });
        expect(off!.band).toBe(alone!.band);
        expect(bylineBandPapers(off!.evidenceDetail.byline)).toBe(rows.length);
        expect(bylineBandShift([off!], false)).toEqual(bylineBandShift([alone!], false));
      }
    });

    it.each([
      ["a rejected paper", [xrow("jd0001", "104", ORCID, "REJECTED")], { rejected: 1 }],
      ["another person's byline", [xrow("xy0002", "300")], { otherHolders: ["xy0002"] }],
      ["a second iD", [xrow("jd0001", "104", OTHER)], { otherIds: [OTHER] }],
    ] as Array<[string, BylineRow[], object]>)("off (%s): what contests the iD only in Crossref is kept for the card", (_, crossref, want) => {
      const none = { rejected: 0, otherHolders: [], otherIds: [] };
      const b = (over: object) => run(P1, { crossref: [...X3, ...crossref], ...over })[0]!.evidenceDetail.byline!;
      expect(b({}).uncountedContests).toEqual({ ...none, ...want });
      expect(b({ crossrefOn: true })).not.toHaveProperty("uncountedContests");
      // PubMed says it too: it is counted already.
      const both = run([...P1, ...crossref.map((r) => ({ ...r, source: "pubmed" as const }))], { crossref });
      expect(both[0]!.evidenceDetail.byline).not.toHaveProperty("uncountedContests");
    });

    it("off: Crossref's papers are listed with their source and counted apart", () => {
      const b = run(P1, { crossref: [...X3, xrow("jd0001", "101")] })[0]!.evidenceDetail.byline!;
      expect(b).toMatchObject({ total: 1, uncounted: 1 });
      expect(b.papers.map((p) => [p.pmid, p.sources])).toEqual([
        ["103", ["crossref"]],
        ["101", ["pubmed", "crossref"]],
      ]);
    });

    it.each([
      ["a rejected paper", [xrow("jd0001", "103", ORCID, "REJECTED")]],
      ["another person's byline", [xrow("xy0002", "300")]],
      ["a second iD", [xrow("jd0001", "103", OTHER)]],
      ["a different iD on PubMed's own paper", [xrow("jd0001", "101", OTHER)]],
    ] as Array<[string, BylineRow[]]>)("on (%s in Crossref): it contests PubMed's papers", (_, crossref) => {
      expect(run(P2)[0]!.band).toBe("strong");
      const r = run(P2, { crossref, crossrefOn: true })[0]!;
      expect(r.band).toBe("weak");
      expect(bylineBandPapers(r.evidenceDetail.byline)).toBe(0);
      expect(shift(P2, crossref)).toEqual({ "strong->weak": 1 });
    });

    it("on file for someone else: Crossref's papers never lift, nor count as a move", () => {
      const heldBy = new Map([[ORCID, ["xy0002"]]]);
      const r = run([], { crossref: X3, crossrefOn: true, heldBy })[0]!;
      expect(r.band).toBe("weak");
      expect(shift([], [...X3, xrow("jd0001", "104")], heldBy)).toEqual({});
    });

    it("Crossref unreadable: PubMed alone, even when on", () => {
      expect(run(P2, { crossrefOn: true })).toEqual(run(P2));
    });

    it("PubMed unreadable: no byline evidence at all", () => {
      const r = run(null, { crossref: X3, crossrefOn: true })[0]!;
      expect(r.band).toBe("weak");
      expect(r.evidenceDetail).not.toHaveProperty("byline");
    });

    // The bulk floor takes a Strong WCM pair with 3+ shared, inst_match, an agreeing name
    // and no competitor. Each such pair has the same band with no byline paper at all.
    it("bulk confirm: whatever passes the WCM floor's other checks has its band without byline papers", () => {
      for (const emailVerified of [true, false])
        for (const historyMatch of [true, false])
          for (const shared of [3, 4, 50])
            for (const byline of [1, 2, 50]) {
              const e = {
                emailVerified,
                historyMatch,
                shared,
                instMatch: true,
                competitor: false,
                nameAgrees: true,
              };
              expect(bandOf({ ...e, byline })).toBe(bandOf(e));
            }
    });
  });

  it("nothing but evidence_detail is added to the row the ETL upserts", () => {
    const without = Object.keys(run(null)[0]!).sort();
    expect(Object.keys(run([row("jd0001", "101")])[0]!).sort()).toEqual(without);
  });

  it("withSharedPaperDetail fills the byline papers too", () => {
    const filled = withSharedPaperDetail(
      run([row("jd0001", "101")]),
      new Map([["101", { doi: "10.1/a", title: "Paper one", year: 2020, journal: "J Example" }]]),
    );
    expect(filled[0]!.evidenceDetail.byline?.papers).toEqual([
      {
        pmid: "101",
        doi: "10.1/a",
        title: "Paper one",
        year: 2020,
        journal: "J Example",
        sources: ["pubmed"],
      },
    ]);
  });
});

it.each([
  ["ORCID_BYLINE_BAND", isBylineBandEnabled],
  ["ORCID_BYLINE_CROSSREF", isBylineCrossrefEnabled],
] as const)('%s is exactly "on"', (name, enabled) => {
  const prev = process.env[name];
  try {
    for (const [v, want] of [
      ["on", true],
      ["ON", false],
      ["1", false],
      ["off", false],
    ] as const) {
      process.env[name] = v;
      expect(enabled()).toBe(want);
    }
    delete process.env[name];
    expect(enabled()).toBe(false);
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
});

describe("loadBylineRows", () => {
  beforeEach(() => {
    query.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  const dbRow = (over: Record<string, unknown> = {}) => ({
    personIdentifier: "JD0001",
    pmid: 101,
    orcid: `${ORCID} `,
    userAssertion: "ACCEPTED",
    ...over,
  });

  it("reads the marked author's iD with the paper's assertion; skips rows it cannot use", async () => {
    query.mockResolvedValue([
      dbRow(),
      dbRow({ pmid: "102", orcid: OTHER.toLowerCase(), userAssertion: "" }),
      dbRow({ pmid: 103, userAssertion: "REJECTED" }),
      dbRow({ personIdentifier: null }),
      dbRow({ pmid: 0 }),
      dbRow({ orcid: "not an iD" }),
      dbRow({ orcid: null }),
    ]);
    expect(await loadBylineRows(1)).toEqual([
      row("JD0001", "101"),
      row("JD0001", "102", OTHER, "PENDING"),
      row("JD0001", "103", ORCID, "REJECTED"),
    ]);
    const { sql, timeout } = query.mock.calls[0]![0] as { sql: string; timeout: number };
    expect(sql).toContain("a.targetAuthor LIKE '1%'");
    expect(sql).toContain("COALESCE(p.targetAuthorCount, 1) <= 1");
    expect(timeout).toBeGreaterThan(0);
  });

  it("a short or empty read is no read: a lost row could be the one that contests an iD", async () => {
    query.mockResolvedValue([dbRow()]);
    expect(await loadBylineRows()).toBeNull();
    query.mockResolvedValue([]);
    expect(await loadBylineRows(1)).toBeNull();
  });

  it("reciterdb unreachable: null, not a failed run", async () => {
    query.mockRejectedValue(new Error("unreachable"));
    expect(await loadBylineRows(1)).toBeNull();
  });
});

describe("loadCrossrefBylineRows", () => {
  beforeEach(() => {
    query.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  const dbRow = (over: Record<string, unknown> = {}) => ({
    personIdentifier: "JD0001",
    pmid: 101,
    orcid: ORCID,
    userAssertion: "ACCEPTED",
    answered: 1,
    ageHours: 3,
    ...over,
  });
  /** The slots query answers first, the holders query second. */
  const answer = (slots: unknown[], holders: unknown[] = []) =>
    query.mockReset().mockResolvedValueOnce(slots).mockResolvedValueOnce(holders);
  const many = (n: number, over: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => dbRow({ pmid: i + 1, ...over }));

  it("reads the live slots' iDs; a slot answered with no iD, or not for this DOI, is no row", async () => {
    answer([
      ...many(100, { orcid: null }),
      dbRow(),
      dbRow({ pmid: 103, orcid: OTHER.toLowerCase(), userAssertion: "REJECTED" }),
      dbRow({ pmid: 104, answered: 0 }),
    ]);
    expect(await loadCrossrefBylineRows(3)).toEqual([
      xrow("JD0001", "101"),
      xrow("JD0001", "103", OTHER, "REJECTED"),
    ]);
    const [slots, holders] = query.mock.calls.map((c) => c[0] as { sql: string; timeout: number });
    for (const { sql, timeout } of [slots!, holders!]) {
      expect(sql).toContain("a.targetAuthor LIKE '1%'");
      expect(sql).toContain("COALESCE(p.targetAuthorCount, 1) <= 1");
      expect(sql).toContain("c.source = 'crossref'");
      expect(sql).toContain("c.doi = LOWER(TRIM(p.doi))");
      expect(timeout).toBeGreaterThan(0);
    }
    expect(slots!.sql).toContain("c.found = 1 AND c.author_rank = a.`rank`");
    expect(slots!.sql).toContain("LEFT JOIN pubsource_article_orcid");
    expect(holders!.sql).toContain("b.pmid = c.pmid AND b.`rank` = c.author_rank");
    expect(holders!.sql).toContain("q.userAssertion = 'ACCEPTED'");
    expect(holders!.sql).toContain("COALESCE(q.targetAuthorCount, 1) <= 1");
  });

  it("someone never asked about who accepted the same entry contests the iD", async () => {
    answer([dbRow(), dbRow({ pmid: 102 })], [dbRow(), dbRow({ personIdentifier: "xy0002" })]);
    const index = indexBylines((await loadCrossrefBylineRows(2))!);
    expect(bylineFactsOf(index, "jd0001", ORCID)).toMatchObject({
      papers: [{ pmid: "102" }, { pmid: "101" }],
      otherHolders: ["xy0002"],
    });
  });

  it("the floor counts answered slots, with or without an iD", async () => {
    const rows = [dbRow(), dbRow({ pmid: 102, orcid: null })];
    answer(rows);
    expect(await loadCrossrefBylineRows(2)).toHaveLength(1);
    answer(rows);
    expect(await loadCrossrefBylineRows(3)).toBeNull();
  });

  it("the default floor", async () => {
    answer(many(279_999));
    expect(await loadCrossrefBylineRows()).toBeNull();
    answer(many(280_000));
    expect(await loadCrossrefBylineRows()).toHaveLength(280_000);
  });

  it("slots still due: up to 2% is complete enough, more is not", async () => {
    const due = (n: number) =>
      many(n, { orcid: null, answered: 0, ageHours: null });
    answer([...many(98), ...due(2)]);
    expect(await loadCrossrefBylineRows(98)).toHaveLength(98);
    answer([...many(97), ...due(3)]);
    expect(await loadCrossrefBylineRows(97)).toBeNull();
  });

  it("the collector stopped: a full table nothing was added to for a week is no read", async () => {
    answer([dbRow({ ageHours: 500 }), dbRow({ pmid: 102, ageHours: 168 })]);
    expect(await loadCrossrefBylineRows(2)).toHaveLength(2);
    answer([dbRow({ ageHours: 500 }), dbRow({ pmid: 102, ageHours: 169 })]);
    expect(await loadCrossrefBylineRows(2)).toBeNull();
  });

  it("the driver's bigints and a slot with no row read the same", async () => {
    answer([dbRow({ answered: 1n, ageHours: 3n })]);
    expect(await loadCrossrefBylineRows(1)).toHaveLength(1);
  });

  it("table absent or reciterdb unreachable: null, not a failed run", async () => {
    query.mockReset().mockRejectedValue(new Error("Table 'pubsource_article_orcid' doesn't exist"));
    expect(await loadCrossrefBylineRows(1)).toBeNull();
  });
});
