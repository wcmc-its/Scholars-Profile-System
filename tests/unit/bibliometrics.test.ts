/**
 * The Bibliometrics report (`EDIT_BIBLIOMETRICS`): the h-index sums, the
 * minimum-paper rule for the written summary, the ranking and filters, and the
 * flag gate on the rail item and on the route. All people and papers invented.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ identity: vi.fn(), authz: vi.fn(), load: vi.fn(), docx: vi.fn(), patentHref: vi.fn(), reach: vi.fn(), connections: vi.fn() }));
vi.mock("@/lib/edit/request", async () => {
  const { NextResponse } = await import("next/server");
  return {
    resolveEditIdentity: h.identity,
    editOk: (payload: Record<string, unknown>) => NextResponse.json({ ok: true, ...payload }),
    editError: (status: number, error: string) => NextResponse.json({ ok: false, error }, { status }),
    logEditFailure: vi.fn(),
  };
});
vi.mock("@/lib/edit/overview-authz", () => ({ authorizeCvExport: h.authz }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: vi.fn() }));
vi.mock("@/lib/edit/bibliometrics-loader", () => ({ loadBibliometricsReport: h.load }));
vi.mock("@/lib/edit/bibliometrics-docx", () => ({ buildBibliometricsDocx: h.docx }));
vi.mock("@/lib/edit/bibliometrics-patents", () => ({ patentReportHref: h.patentHref }));
vi.mock("@/lib/edit/downstream-reach-entry", () => ({ loadScholarReach: h.reach, loadScholarConnections: h.connections }));
vi.mock("@/lib/db", () => ({ db: { read: {} } }));

import { GET } from "@/app/api/edit/bibliometrics/route";
import { visibleAttrKeys } from "@/components/edit/edit-page";
import {
  BIBLIOMETRICS_MIN_RATED_ARTICLES,
  BIBLIOMETRICS_TOP_PAPERS,
  buildBibliometricsReport,
  h5IndexOf,
  hIndexOf,
  parseBibliometricsFilters,
  patentsLine,
  rankPapers,
  unratedNote,
  type BibliometricsFilters,
  type BibliometricsPubRow,
} from "@/lib/edit/bibliometrics";

const NOW = new Date("2026-11-25T12:00:00Z");
const NO_FILTERS: BibliometricsFilters = { authorship: "all", yearFrom: null, yearTo: null };

let seq = 0;
function pub(over: Partial<BibliometricsPubRow> = {}): BibliometricsPubRow {
  seq += 1;
  return {
    pmid: String(90000000 + seq),
    title: `Invented paper ${seq}`,
    authorsString: "Quill A, Vale J, Marsh T, Okafor N",
    journal: "Journal of Examples",
    year: 2020,
    volume: "12",
    issue: "3",
    pages: "100-9",
    doi: null,
    publicationType: "Academic Article",
    citationCount: 10,
    citedByCount: 8,
    nihPercentile: 50,
    relativeCitationRatio: 1,
    dateAddedToEntrez: new Date("2020-06-01T00:00:00Z"),
    authorityBodies: null,
    authorityCount: 0,
    guidelineCount: 0,
    consensusCount: 0,
    reviewCount: 0,
    patentFamilyCount: 0,
    position: 2,
    isFirst: false,
    isLast: false,
    ...over,
  };
}
const build = (visible: BibliometricsPubRow[], filters = NO_FILTERS, all = visible) =>
  buildBibliometricsReport({
    scholar: { cwid: "zzz9001", name: "Jordan Vale", hIndex: null },
    visible,
    all,
    filters,
    now: NOW,
  });

describe("hIndexOf", () => {
  it("is the largest h with h papers cited at least h times", () => {
    expect(hIndexOf([])).toBe(0);
    expect(hIndexOf([0, 0])).toBe(0);
    expect(hIndexOf([10, 8, 5, 4, 3])).toBe(4);
    expect(hIndexOf([3, 3, 3])).toBe(3);
    expect(hIndexOf([1, 100])).toBe(1);
    expect(hIndexOf([25, 8, 5, 3, 3])).toBe(3);
  });
});

describe("h5IndexOf", () => {
  const at = (iso: string | null, citedByCount: number | null, year: number | null = null) => ({
    dateAddedToEntrez: iso ? new Date(iso) : null,
    citedByCount,
    year,
  });

  it("counts only papers added to PubMed in the five years before now", () => {
    const pubs = [
      at("2025-01-10T00:00:00Z", 9),
      at("2023-03-01T00:00:00Z", 7),
      at("2021-11-26T00:00:00Z", 5), // one day inside the window
      at("2021-11-25T00:00:00Z", 50), // on the cutoff day: out
      at("2015-05-05T00:00:00Z", 400),
    ];
    expect(h5IndexOf(pubs, NOW)).toBe(3);
    expect(hIndexOf(pubs.map((p) => p.citedByCount ?? 0))).toBe(5);
  });

  it("uses iCite counts, treating an unrated paper as uncited", () => {
    expect(h5IndexOf([at("2024-01-01T00:00:00Z", null), at("2024-01-01T00:00:00Z", 1)], NOW)).toBe(1);
  });

  it("falls back to 1 January of the publication year without an Entrez date", () => {
    expect(h5IndexOf([at(null, 4, 2022), at(null, 4, 2021), at(null, 4, null)], NOW)).toBe(1);
  });
});

describe("buildBibliometricsReport — the minimum-paper rule", () => {
  const rated = (n: number) => Array.from({ length: n }, () => pub({ nihPercentile: 95, isLast: true }));

  it("drops the summary below the minimum but keeps every figure", () => {
    const r = build([...rated(BIBLIOMETRICS_MIN_RATED_ARTICLES - 1), pub({ nihPercentile: null })]);
    expect(r.summary).toEqual([]);
    expect(r.output.total).toBe(BIBLIOMETRICS_MIN_RATED_ARTICLES);
    expect(r.metrics.ratedArticles).toBe(BIBLIOMETRICS_MIN_RATED_ARTICLES - 1);
    expect(r.metrics.topDecilePct).toBe(100);
    expect(r.papers.rows).toHaveLength(BIBLIOMETRICS_TOP_PAPERS);
  });

  it("writes the summary at the minimum, counting rated research articles only", () => {
    const r = build([
      ...rated(BIBLIOMETRICS_MIN_RATED_ARTICLES - 1),
      pub({ nihPercentile: 20, year: 2011, guidelineCount: 2 }),
      pub({ nihPercentile: 99, publicationType: "Review" }), // not a research article
    ]);
    expect(r.summary).toEqual([
      "has published 10 research articles since 2011, 9 as first or senior author.",
      "Of the 10 articles with an NIH percentile, 90% rank in the top 10% of NIH-funded papers in their field and year.",
      "1 article is cited in clinical practice guidelines.",
    ]);
  });

  it("names the health authorities, and leaves the sentence out when nothing cites the work", () => {
    const cited = pub({
      nihPercentile: 95,
      authorityCount: 3,
      authorityBodies: [
        { body: "WHO", count: 2 },
        { body: "National Academies", count: 1 },
      ],
    });
    expect(build([...rated(9), cited, pub({ guidelineCount: 1 })]).summary[2]).toBe(
      "1 article is cited in clinical practice guidelines, and 1 in documents from the National Academies or the WHO.",
    );
    expect(build(rated(10)).summary).toHaveLength(2);
  });
});

describe("buildBibliometricsReport — figures", () => {
  it("counts output by position and by year, over research articles only", () => {
    const r = build([
      pub({ isFirst: true, position: 1, year: 2026 }),
      pub({ isFirst: true, isLast: true, position: 1, year: 2026 }), // sole author: first
      pub({ isLast: true, year: 2017 }),
      pub({ year: 2016 }), // before the ten charted years
      pub({ publicationType: "Editorial", year: 2026 }),
    ]);
    expect(r.output).toMatchObject({ first: 2, senior: 1, coAuthor: 1, total: 4 });
    expect(r.output.byYear).toHaveLength(10);
    expect(r.output.byYear[0]).toEqual({ year: 2017, count: 1, first: 0, senior: 1, co: 0 });
    expect(r.output.byYear[9]).toEqual({ year: 2026, count: 2, first: 2, senior: 0, co: 0 });
    // Each year's split adds up to its count.
    for (const y of r.output.byYear) expect(y.first + y.senior + y.co).toBe(y.count);
    expect(r.yearRange).toEqual({ min: 2016, max: 2026 });
  });

  it("reports unrated articles apart from the top-decile share", () => {
    const r = build([pub({ nihPercentile: 90 }), pub({ nihPercentile: 89.9 }), pub({ nihPercentile: null })]);
    expect(r.metrics).toMatchObject({ ratedArticles: 2, unratedArticles: 1, topDecilePct: 50 });
    expect(unratedNote(r)).toContain("1 article has no NIH percentile");
    expect(unratedNote(build([pub()]))).toBeNull();
  });

  it("takes the stored h-index when there is one and sums it otherwise; h5 uses every authorship", () => {
    const hidden = pub({ citedByCount: 30, dateAddedToEntrez: new Date("2025-01-01T00:00:00Z") });
    const shown = pub({ citedByCount: 30, dateAddedToEntrez: new Date("2025-01-01T00:00:00Z") });
    const r = build([shown], NO_FILTERS, [shown, hidden]);
    expect(r.metrics.hIndex).toBe(2);
    expect(r.metrics.h5Index).toBe(2);
    expect(r.output.total).toBe(1);
    const stored = buildBibliometricsReport({
      scholar: { cwid: "zzz9001", name: "Jordan Vale", hIndex: 41 },
      visible: [shown],
      all: [shown],
      filters: NO_FILTERS,
      now: NOW,
    });
    expect(stored.metrics.hIndex).toBe(41);
  });

  it("counts papers cited per level", () => {
    const r = build([
      pub({ guidelineCount: 2, reviewCount: 5 }),
      pub({ reviewCount: 1, consensusCount: 1 }),
      pub({ authorityCount: 1, authorityBodies: [{ body: "NICE", count: 1 }] }),
    ]);
    expect(r.policy.map((l) => [l.level, l.papers])).toEqual([
      ["authority", 1],
      ["guideline", 1],
      ["consensus", 1],
      ["review", 2],
    ]);
  });
});

describe("patents citing the work", () => {
  it("counts every visible paper a patent cites, of any type, and carries each paper's count", () => {
    const article = pub({ patentFamilyCount: 14, nihPercentile: 99 });
    const review = pub({ patentFamilyCount: 1, publicationType: "Review" });
    const hidden = pub({ patentFamilyCount: 7 });
    const r = build([article, review, pub()], NO_FILTERS, [article, review, hidden]);
    // The loader fills the inventions, the cut-off and the link.
    expect(r.patents).toEqual({ papers: 2, inventions: 0, list: [], dataEnd: null, reportHref: null });
    expect(r.papers.rows.map((p) => p.patents)).toEqual([14, 0]);
  });

  it("words the line with its singulars, and has none when no patent cites the work", () => {
    const line = (papers: number, inventions: number) =>
      patentsLine({ papers, inventions, list: [], dataEnd: null, reportHref: null });
    expect(line(12, 1030)).toBe("12 papers cited by 1,030 patented inventions");
    expect(line(1, 1)).toBe("1 paper cited by 1 patented invention");
    expect(line(0, 0)).toBeNull();
    expect(build([pub()]).patents.papers).toBe(0);
  });
});

describe("most impactful papers", () => {
  it("ranks by percentile, then senior before first before co-author, then ratio, then citations", () => {
    const a = pub({ nihPercentile: 99, relativeCitationRatio: 1 });
    const b = pub({ nihPercentile: 98, isFirst: true, position: 1, relativeCitationRatio: 9 });
    const c = pub({ nihPercentile: 98, isLast: true, relativeCitationRatio: 2 });
    const d = pub({ nihPercentile: 98, isLast: true, relativeCitationRatio: 2, citationCount: 500 });
    const e = pub({ nihPercentile: 98, isLast: true, relativeCitationRatio: 3 });
    const unrated = pub({ nihPercentile: null, citationCount: 9000 });
    expect(rankPapers([unrated, c, b, a, d, e]).map((p) => p.pmid)).toEqual(
      [a, e, d, c, b, unrated].map((p) => p.pmid),
    );
  });

  it("filters by authorship and year, and reports how many matched", () => {
    const pubs = [
      pub({ year: 2012, isLast: true }),
      pub({ year: 2018, isFirst: true, position: 1 }),
      pub({ year: 2018 }),
      pub({ year: 2024 }),
    ];
    const lead = build(pubs, { authorship: "lead", yearFrom: null, yearTo: null });
    expect(lead.papers.matching).toBe(2);
    const window = build(pubs, { authorship: "all", yearFrom: 2015, yearTo: 2020 });
    expect(window.papers.rows.map((p) => p.dated.slice(0, 4))).toEqual(["2018", "2018"]);
    // The filters narrow the list only; the rest of the report is unchanged.
    expect(window.output.total).toBe(4);
  });

  it("lists the first three authors and bolds the scholar only in their own slot", () => {
    const [second, late, other] = build([
      pub({ nihPercentile: 99, position: 2 }),
      pub({ nihPercentile: 98, position: 4, authorsString: "Quill A, Marsh T, Okafor N, Vale J" }),
      pub({ nihPercentile: 97, position: 2, authorsString: "Quill A, Marsh T, Okafor N" }),
    ]).papers.rows;
    expect(second!.authors).toEqual([
      { name: "Quill A", bold: false },
      { name: "Vale J", bold: true },
      { name: "Marsh T", bold: false },
    ]);
    expect(second!.etAl).toBe(true);
    expect(second!.dated).toBe("2020;12(3):100-9");
    expect(late!.authors.some((a) => a.bold)).toBe(false);
    // The name in the scholar's slot is someone else's: no bold.
    expect(other!.authors.some((a) => a.bold)).toBe(false);
    expect(other!.etAl).toBe(false);
  });

  it("drops the ((…)) markers the stored author string puts around WCM authors", () => {
    const [marked] = build([
      pub({ nihPercentile: 99, position: 2, authorsString: "((Quill A)), ((Vale J)), Marsh T" }),
    ]).papers.rows;
    expect(marked!.authors).toEqual([
      { name: "Quill A", bold: false },
      { name: "Vale J", bold: true },
      { name: "Marsh T", bold: false },
    ]);
  });
});

describe("parseBibliometricsFilters", () => {
  it("reads the three filters and ignores junk", () => {
    expect(parseBibliometricsFilters(new URLSearchParams("authorship=lead&from=2015&to=2024"))).toEqual({
      authorship: "lead",
      yearFrom: 2015,
      yearTo: 2024,
    });
    expect(parseBibliometricsFilters(new URLSearchParams("authorship=x&from=abc&to=99999"))).toEqual(NO_FILTERS);
  });
});

describe("EDIT_BIBLIOMETRICS — the rail item", () => {
  type Mode = Parameters<typeof visibleAttrKeys>[0];
  const MODES: Mode[] = ["self", "superuser", "comms_steward", "proxy", "unit-admin", "read-only"];
  // cvEnabled (7th) and bibliometricsEnabled (16th, last) set together.
  const keys = (mode: Mode, on: boolean) =>
    visibleAttrKeys(mode, false, false, false, false, false, on, false, false, false, false, false, false, false, false, on);

  it("is absent with the flag off, on every surface", () => {
    for (const mode of MODES) expect(keys(mode, false)).not.toContain("bibliometrics");
    expect(visibleAttrKeys("self", false)).not.toContain("bibliometrics");
  });

  it("is offered wherever the CV export is, with the flag on", () => {
    for (const mode of MODES) {
      const k = keys(mode, true);
      expect(k).toContain("bibliometrics");
      expect(k).toContain("cv");
    }
  });
});

describe("GET /api/edit/bibliometrics", () => {
  const get = (qs = "") => GET(new NextRequest(`http://localhost/api/edit/bibliometrics?${qs}`));
  const SESSION = { cwid: "zzz9001", isSuperuser: false };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("EDIT_BIBLIOMETRICS", "on");
    h.identity.mockResolvedValue({ session: SESSION, realCwid: "zzz9001", impersonatedCwid: null });
    h.authz.mockResolvedValue({ ok: true, viaUnitAdminUnit: null });
    h.load.mockImplementation(async () => ({
      scholar: { cwid: "zzz9001", name: "Jordan Vale" },
      patents: { papers: 0, inventions: 0, dataEnd: null, reportHref: null },
    }));
    h.patentHref.mockResolvedValue("/edit/reports/patent-citations?person=zzz9002");
    h.docx.mockResolvedValue(Buffer.from("docx"));
    h.reach.mockResolvedValue(null);
    h.connections.mockResolvedValue(null);
  });

  it("404s before any session or database work unless the flag is exactly on", async () => {
    for (const value of ["off", "true", ""]) {
      vi.stubEnv("EDIT_BIBLIOMETRICS", value);
      expect((await get()).status).toBe(404);
    }
    expect(h.identity).not.toHaveBeenCalled();
    expect(h.load).not.toHaveBeenCalled();
  });

  it("401s without a session", async () => {
    h.identity.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });

  it("refuses a target the CV-export rule refuses, and reads nothing", async () => {
    h.authz.mockResolvedValue({ ok: false, reason: "not_self" });
    const res = await get("cwid=zzz9002");
    expect(res.status).toBe(403);
    expect(h.authz.mock.calls[0]![0]).toMatchObject({ entityId: "zzz9002", realCwid: "zzz9001" });
    expect(h.load).not.toHaveBeenCalled();
  });

  it("defaults to the session's own report and passes the filters through", async () => {
    const res = await get("authorship=lead&from=2015");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, report: { scholar: { cwid: "zzz9001" } } });
    expect(h.load).toHaveBeenCalledWith("zzz9001", { authorship: "lead", yearFrom: 2015, yearTo: null });
    expect(h.docx).not.toHaveBeenCalled();
  });

  it("returns the same report as a Word attachment with format=docx", async () => {
    const res = await get("format=docx&to=2020");
    expect(res.headers.get("Content-Type")).toContain("wordprocessingml");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="bibliometrics-zzz9001.docx"');
    expect(h.docx).toHaveBeenCalledWith(await h.load.mock.results[0]!.value);
    expect(h.load).toHaveBeenCalledWith("zzz9001", { authorship: "all", yearFrom: null, yearTo: 2020 });
  });

  it("adds the link to report 25, decided for this viewer, only when a patent cites the work", async () => {
    await get();
    expect(h.patentHref).not.toHaveBeenCalled();

    h.load.mockImplementation(async () => ({
      scholar: { cwid: "zzz9002", name: "Rowan Marsh" },
      patents: { papers: 3, inventions: 5, dataEnd: "31 December 2025", reportHref: null },
    }));
    const { report } = await (await get("cwid=zzz9002")).json();
    expect(report.patents.reportHref).toBe("/edit/reports/patent-citations?person=zzz9002");
    expect(h.patentHref).toHaveBeenCalledWith(SESSION, "zzz9002");

    // A viewer who may not open report 25 gets no link.
    h.patentHref.mockResolvedValue(null);
    expect((await (await get("cwid=zzz9002")).json()).report.patents.reportHref).toBeNull();
  });

  it("404s for a cwid with no scholar", async () => {
    h.load.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it("the report request answers exactly as before and never loads the Downstream reach block", async () => {
    expect(await (await get()).json()).toEqual({ ok: true, report: await h.load.mock.results[0]!.value });
    await get("authorship=lead&from=2020");
    await get("format=docx");
    expect(h.reach).not.toHaveBeenCalled();
  });

  it("part=reach answers the block alone, for the target scholar and the viewer's session", async () => {
    const reach = { lines: [{ type: "clinical", label: "Clinical studies", papers: 3, href: "/edit/reports/27?person=zzz9002" }], note: "n" };
    h.reach.mockResolvedValue(reach);
    expect(await (await get("cwid=zzz9002&part=reach")).json()).toEqual({ ok: true, reach });
    expect(h.reach).toHaveBeenCalledWith("zzz9002", SESSION);
    // The report is not loaded for it.
    expect(h.load).not.toHaveBeenCalled();
  });

  it("part=reach sits behind the same flag, session and target check as the report", async () => {
    h.authz.mockResolvedValue({ ok: false, reason: "not_self" });
    expect((await get("cwid=zzz9002&part=reach")).status).toBe(403);
    h.identity.mockResolvedValue(null);
    expect((await get("part=reach")).status).toBe(401);
    vi.stubEnv("EDIT_BIBLIOMETRICS", "off");
    expect((await get("part=reach")).status).toBe(404);
    expect(h.reach).not.toHaveBeenCalled();
  });

  it("part=reach answers null when there is no block, or it fails to load", async () => {
    expect(await (await get("part=reach")).json()).toEqual({ ok: true, reach: null });
    h.reach.mockRejectedValue(new Error("boom"));
    const res = await get("part=reach");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reach: null });
  });
});

describe("translational stage section", () => {
  const staged = (stage: string | null, confidence: string | null, over: Partial<BibliometricsPubRow> = {}) =>
    pub({ translationalStage: stage, translationalStageConfidence: confidence, ...over });
  const withStages = (visible: BibliometricsPubRow[], filters = NO_FILTERS) =>
    buildBibliometricsReport({
      scholar: { cwid: "zzz9001", name: "Jordan Vale", hIndex: null },
      visible,
      all: visible,
      filters,
      now: NOW,
      stagesEnabled: true,
    });

  it("is absent, with no stage definition, while stage data is off", () => {
    const r = build([staged("T0", "high")]);
    expect(r.stages).toBeNull();
    expect(r.definitions.some((d) => d.term === "Translational stage")).toBe(false);
  });

  it("counts by report 26's rule, adds up, and lists each bucket's papers newest first", () => {
    const pubs = [
      staged("T0", "high", { year: 2019 }),
      staged("T0", null, { year: 2022 }),
      staged("T2", "medium"),
      staged("T1", "low"), // unsure: No stage
      staged("NA", "high"), // outside the spectrum: No stage
      staged(null, null),
      staged("T2", "high", { publicationType: "Review" }), // not a research article
    ];
    const s = withStages(pubs).stages!;
    expect(s.counts).toEqual({ T0: 2, T1: 0, T2: 1, "T3-4": 0, none: 3 });
    // Shares are among the 3 staged papers only (No stage is not in the denominator).
    expect(s.shares).toEqual({ T0: 67, T1: 0, T2: 33, "T3-4": 0 });
    expect(s.papers.T0.map((p) => p.year)).toEqual([2022, 2019]);
    expect(Object.values(s.papers).flat()).toHaveLength(6);
    expect(s.portfolioHref).toBeNull();
    expect(withStages(pubs).definitions.at(-2)?.term).toBe("Translational stage");
  });

  it("follows the Authorship and year filters", () => {
    const pubs = [
      staged("T0", "high", { isFirst: true, year: 2021 }),
      staged("T0", "high", { year: 2021 }), // co-author
      staged("T1", "high", { isLast: true, year: 2015 }),
    ];
    expect(withStages(pubs, { authorship: "lead", yearFrom: null, yearTo: null }).stages!.counts).toEqual({
      T0: 1, T1: 1, T2: 0, "T3-4": 0, none: 0,
    });
    expect(withStages(pubs, { authorship: "all", yearFrom: 2020, yearTo: null }).stages!.counts.T0).toBe(2);
    expect(withStages(pubs, { authorship: "all", yearFrom: 2020, yearTo: null }).stages!.counts.T1).toBe(0);
  });

  it("the Word document carries the table only when the section is on", async () => {
    const { buildBibliometricsDocx } = await vi.importActual<typeof import("@/lib/edit/bibliometrics-docx")>(
      "@/lib/edit/bibliometrics-docx",
    );
    const JSZip = (await import("jszip")).default;
    const xml = async (r: ReturnType<typeof build>) =>
      (await JSZip.loadAsync(await buildBibliometricsDocx(r))).file("word/document.xml")!.async("string");
    const pubs = [staged("T2", "high")];
    expect(await xml(withStages(pubs))).toContain("Translational stage");
    expect(await xml(build(pubs))).not.toContain("Translational stage");
  });
});
