/**
 * @vitest-environment jsdom
 *
 * The `/edit` Bibliometrics panel: it renders the section model the route
 * returns, opens a paper's citing documents behind "More", and carries the
 * on-screen filters to the Word download. All people and papers invented.
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/edit/scholar-hover-card", () => ({
  ScholarHoverCard: ({ cwid, children }: { cwid: string; children: React.ReactNode }) => (
    <span data-hover-cwid={cwid}>{children}</span>
  ),
}));

import { BibliometricsTool } from "@/components/edit/bibliometrics-tool";
import { buildBibliometricsReport, type BibliometricsPubRow } from "@/lib/edit/bibliometrics";
import type { ScholarReach } from "@/lib/edit/downstream-reach-entry";

const pub = (i: number, over: Partial<BibliometricsPubRow> = {}): BibliometricsPubRow => ({
  pmid: String(90000100 + i),
  title: `Invented paper ${i}`,
  authorsString: "Vale J, Quill A",
  journal: "Journal of Examples",
  year: 2019,
  volume: "4",
  issue: null,
  pages: "1-9",
  doi: "10.5555/example." + i,
  publicationType: "Academic Article",
  citationCount: 40 - i,
  citedByCount: 30,
  nihPercentile: 95 - i,
  relativeCitationRatio: 3.25,
  dateAddedToEntrez: new Date("2019-02-01T00:00:00Z"),
  authorityBodies: null,
  authorityCount: 0,
  guidelineCount: 0,
  consensusCount: 0,
  reviewCount: 0,
  patentFamilyCount: 0,
  position: 1,
  isFirst: true,
  isLast: false,
  ...over,
});

/** `patents[i]` is paper i's count of citing inventions. */
function report(n: number, patents: number[] = []) {
  const pubs = Array.from({ length: n }, (_, i) =>
    pub(i, {
      ...(i === 0 ? { guidelineCount: 1, authorityCount: 1, authorityBodies: [{ body: "WHO", count: 1 }] } : {}),
      patentFamilyCount: patents[i] ?? 0,
    }),
  );
  const r = buildBibliometricsReport({
    scholar: { cwid: "zzz9001", name: "Jordan Vale", hIndex: 12 },
    visible: pubs,
    all: pubs,
    filters: { authorship: "all", yearFrom: null, yearTo: null },
    now: new Date("2026-11-25T12:00:00Z"),
  });
  r.papers.rows[0]!.citing = [
    {
      id: 1,
      level: "guideline",
      title: "An invented guideline",
      year: 2022,
      url: "https://pubmed.ncbi.nlm.nih.gov/90000999/",
      issuingBody: null,
      authors: "Marsh T, Okafor N",
      journal: "Guideline J",
      volume: "9",
      issue: null,
      pages: "10-20",
      doi: null,
      publisher: null,
      pmid: "90000999",
      bookshelfId: null,
      locations: [],
    },
  ];
  return r;
}

const fetchMock = vi.fn();
const respond = (n: number) =>
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, report: report(n) }) });
/** Papers 0, 1 and 2 are cited by 14, 1 and 0 inventions; the loader's fields filled in. */
const respondWithPatents = (reportHref: string | null) => {
  const r = report(12, [14, 1]);
  r.patents = { ...r.patents, inventions: 15, dataEnd: "31 December 2025", reportHref };
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, report: r }) });
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BibliometricsTool", () => {
  it("states coverage first, splits the unstaged by reason, and every count opens its papers", async () => {
    const stagesReport = (pubs: BibliometricsPubRow[]) =>
      buildBibliometricsReport({
        scholar: { cwid: "zzz9001", name: "Jordan Vale", hIndex: 12 },
        visible: pubs,
        all: pubs,
        filters: { authorship: "all", yearFrom: null, yearTo: null },
        now: new Date("2026-11-25T12:00:00Z"),
        stagesEnabled: true,
      });
    const r = stagesReport([
      pub(1, { year: 2021, translationalStage: "T2", translationalStageConfidence: "high", title: "A staged paper" }),
      pub(2, { year: 2018, translationalStage: null, title: "An older paper" }),
      pub(3, { year: 2022, translationalStage: "T1", translationalStageConfidence: "low", title: "An unsure paper" }),
      pub(4, { year: 2022, translationalStage: "NA", translationalStageConfidence: "high" }),
      pub(5, { year: 2023, translationalStage: null }),
    ]);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, report: r }) });
    render(<BibliometricsTool entityId="zzz9001" />);
    const section = await screen.findByTestId("bibliometrics-stages");
    expect(screen.getByTestId("bibliometrics-stage-coverage").textContent).toBe(
      "Stage assigned for 1 of 5 articles (20%). The other 4 are unstaged: " +
        "1 published before 2020, outside the years ReCiterAI stages; 1 low-confidence; " +
        "1 outside the T0\u2013T4 spectrum, which is common for health services and informatics research; " +
        "1 from 2020 on that ReCiterAI has not staged (no usable abstract, or not yet processed). Shares below are of the 1.",
    );
    // Each reason opens its own papers; "4" opens all of them.
    const open = (k: string) => fireEvent.click(screen.getByTestId(`bibliometrics-stage-count-${k}`));
    open("before");
    expect(within(section).getByRole("link", { name: "An older paper" })).toBeTruthy();
    expect(within(section).queryByRole("link", { name: "An unsure paper" })).toBeNull();
    open("none");
    expect(within(section).getAllByRole("listitem")).toHaveLength(4);
    // Under 25% coverage the breakdown starts folded; bars are as long as shares.
    const fold = screen.getByTestId("bibliometrics-stage-fold") as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    open("T2");
    expect(within(section).getByRole("link", { name: "A staged paper" })).toBeTruthy();
    const bars = [...section.querySelectorAll<HTMLElement>(".bg-apollo-slate.h-2")].map((b) => b.style.width);
    expect(bars).toEqual(["0%", "0%", "100%", "0%"]);
    expect(screen.queryByText("Full translational profile", { exact: false })).toBeNull();

    cleanup();
    const wide = stagesReport([
      pub(1, { year: 2021, translationalStage: "T2", translationalStageConfidence: "high" }),
      pub(2, { year: 2021, translationalStage: "T0", translationalStageConfidence: "high" }),
      pub(3, { year: 2021, translationalStage: "NA" }),
    ]);
    wide.stages!.portfolioHref = "/edit/scholar/zzz9001/translational-portfolio";
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, report: wide }) });
    render(<BibliometricsTool entityId="zzz9001" />);
    expect((await screen.findByTestId("bibliometrics-stage-coverage")).textContent).toBe(
      "Stage assigned for 2 of 3 articles (67%). The other 1 is unstaged: " +
        "1 outside the T0\u2013T4 spectrum, which is common for health services and informatics research. Shares below are of the 2.",
    );
    expect(screen.queryByTestId("bibliometrics-stage-fold")).toBeNull();
    // A zero stays plain text, never a button.
    expect(screen.queryByTestId("bibliometrics-stage-count-T1")).toBeNull();
    expect(screen.getByText("Full translational profile", { exact: false }).getAttribute("href")).toBe(
      "/edit/scholar/zzz9001/translational-portfolio",
    );
  });

  it("has no stage section while stage data is off", async () => {
    respond(3);
    render(<BibliometricsTool entityId="zzz9001" />);
    await screen.findByTestId("bibliometrics-report");
    expect(screen.queryByTestId("bibliometrics-stages")).toBeNull();
  });

  it("renders the report for the scholar it was given", async () => {
    respond(12);
    render(<BibliometricsTool entityId="zzz9001" />);
    const summary = await screen.findByTestId("bibliometrics-summary");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/edit/bibliometrics?cwid=zzz9001");
    expect(summary.textContent).toContain("Jordan Vale has published 12 research articles since 2019");
    expect(summary.querySelector('[data-hover-cwid="zzz9001"]')?.textContent).toBe("Jordan Vale");
    expect(screen.getByText("h-index, all publications").previousSibling?.textContent).toBe("12");
    // Five tiles, in the Summary section: no separate Citation metrics card.
    expect(screen.getByTestId("bibliometrics-tiles").children).toHaveLength(5);
    expect(screen.getByText(/Showing 10 of 12\./)).toBeTruthy();
    expect(screen.getByText("Updated November 25, 2026.", { exact: false })).toBeTruthy();
    // The scholar is bold in the author list; the other author is not.
    expect(document.querySelectorAll("strong")[0]?.textContent).toBe("Vale J");
  });

  it("drops the summary below the minimum and says why", async () => {
    respond(3);
    render(<BibliometricsTool entityId="zzz9001" />);
    expect(await screen.findByTestId("bibliometrics-no-summary")).toBeTruthy();
    expect(screen.queryByTestId("bibliometrics-summary")).toBeNull();
    expect(screen.getByText("h5-index, last 5 years")).toBeTruthy();
  });

  it("opens a paper's citing documents behind More", async () => {
    respond(12);
    render(<BibliometricsTool entityId="zzz9001" />);
    const more = await screen.findByRole("button", { name: "More" });
    expect(screen.getByText("WHO guideline")).toBeTruthy();
    expect(screen.queryByText("Clinical practice guidelines", { exact: false, selector: "div" })).toBeNull();
    fireEvent.click(more);
    expect(screen.getByRole("link", { name: "An invented guideline" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Less" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("refetches on a filter change and points the Word download at the same filters", async () => {
    respond(12);
    render(<BibliometricsTool entityId="zzz9001" />);
    await screen.findByTestId("bibliometrics-report");
    fireEvent.click(screen.getByLabelText("First or senior author only"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/edit/bibliometrics?cwid=zzz9001&authorship=lead"),
    );
    expect(screen.getByTestId("bibliometrics-download").getAttribute("href")).toBe(
      "/api/edit/bibliometrics?cwid=zzz9001&authorship=lead&format=docx",
    );
  });

  it("marks the sections that follow the filters as Filtered", async () => {
    respond(12);
    render(<BibliometricsTool entityId="zzz9001" />);
    await screen.findByTestId("bibliometrics-report");
    const marked = [...document.querySelectorAll("h3")]
      .filter((h) => h.nextElementSibling?.textContent === "Filtered")
      .map((h) => h.textContent);
    // Every section but Downstream reach (one scholar, unfiltered, until it
    // joins Downstream impact); the h-index and h5 tiles say "all publications".
    expect(marked).toEqual(["Summary", "Output", "Guideline and policy citations", "Most impactful papers"]);
    // The filters and Download share the bar above the sections.
    const bar = screen.getByRole("heading", { level: 2, name: "Bibliometrics" }).closest("header")!;
    expect(within(bar).getByLabelText("First or senior author only")).toBeTruthy();
    expect(within(bar).getByTestId("bibliometrics-download")).toBeTruthy();
  });

  it("stacks each year's bar by author position, senior at the base, with each part named on hover", async () => {
    const r = report(3);
    r.output.byYear = r.output.byYear.map((y, i) => (i === 9 ? { ...y, count: 6, first: 1, senior: 3, co: 2 } : { ...y, count: 0, first: 0, senior: 0, co: 0 }));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, report: r }) });
    render(<BibliometricsTool entityId="zzz9001" />);
    const bar = await screen.findByTestId(`bibliometrics-year-${r.output.byYear[9]!.year}`);
    const y = r.output.byYear[9]!.year;
    expect(bar.getAttribute("title")).toBe(`${y}: 6 (first 1, senior 3, co-author 2)`);
    // DOM order is base first (column-reverse): senior, co-author, first.
    expect([...bar.children].map((c) => c.getAttribute("title"))).toEqual([`${y}, senior author: 3`, `${y}, co-author: 2`, `${y}, first author: 1`]);
    expect([...bar.children].map((c) => (c as HTMLElement).style.flexGrow)).toEqual(["3", "2", "1"]);
    // An empty year draws no segment.
    expect(screen.getByTestId(`bibliometrics-year-${r.output.byYear[0]!.year}`).children).toHaveLength(0);
  });

  it("lists the citing inventions on the card and under a paper, for a viewer with no report access", async () => {
    const r = report(12, [14, 1]);
    const inv = (id: number, title: string, papers: number) => ({
      id,
      title,
      url: `https://patents.google.com/patent/US9000000${id}B2/en`,
      holder: "Example Biotech, Inc.",
      year: 2020 + id,
      granted: true,
      number: `US 9000000${id} B2`,
      related: 0,
      papers,
    });
    r.patents = { ...r.patents, inventions: 2, dataEnd: "31 December 2025", reportHref: null, list: [inv(1, "Widget calibration", 2), inv(2, "Compound and uses", 1)] };
    r.papers.rows[1]!.citingPatents = { items: [inv(2, "Compound and uses", 1)], total: 1 };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, report: r }) });
    render(<BibliometricsTool entityId="zzz9001" />);
    const card = await screen.findByTestId("bibliometrics-patents");
    expect(within(card).getByText("Widget calibration").closest("a")!.getAttribute("href")).toBe("https://patents.google.com/patent/US90000001B2/en");
    expect(card.textContent).toContain("cites 2 papers");
    expect(card.textContent).toContain("cites 1 paper");
    expect(within(card).queryByTestId("bibliometrics-patents-report")).toBeNull();
    // Under the paper, behind "More", as the publication modal lists them.
    const row = screen.getByTestId("bibliometrics-paper-90000101");
    fireEvent.click(within(row).getByRole("button", { name: "More" }));
    const below = document.getElementById("bibliometrics-citing-90000101")!;
    expect(within(below).getByText("Patents that cite this paper")).toBeTruthy();
    expect(within(below).getByText("Compound and uses")).toBeTruthy();
  });

  it("shows the patents line, each paper's count and the Excel download when a patent cites the work", async () => {
    respondWithPatents("/edit/reports/patent-citations?person=zzz9001");
    render(<BibliometricsTool entityId="zzz9001" />);
    const line = await screen.findByTestId("bibliometrics-patents-line");
    expect(line.textContent).toBe("2 papers cited by 15 patented inventions, in patent data through 31 December 2025.");
    expect(screen.getByText(/Patents on which the scholar is an inventor are not separated out\./)).toBeTruthy();
    const download = screen.getByTestId("bibliometrics-patents-download");
    expect(download.textContent).toBe("Download patents citing this work (Excel)");
    expect(download.getAttribute("href")).toBe("/api/edit/bibliometrics/patents?cwid=zzz9001");
    expect(screen.getByTestId("bibliometrics-patents-report").getAttribute("href")).toBe(
      "/edit/reports/patent-citations?person=zzz9001",
    );
    // Plain text beside the other counts, singular for one, absent for none.
    const paper = (i: number) => screen.getByTestId(`bibliometrics-paper-${90000100 + i}`).textContent ?? "";
    expect(paper(0)).toContain("14 patents");
    expect(paper(1)).toContain("1 patent");
    expect(paper(1)).not.toContain("1 patents");
    expect(paper(2)).not.toMatch(/\d patents?\b/);
  });

  it("leaves out the link to report 25 for a viewer who may not open it", async () => {
    respondWithPatents(null);
    render(<BibliometricsTool entityId="zzz9001" />);
    expect(await screen.findByTestId("bibliometrics-patents-download")).toBeTruthy();
    expect(screen.queryByTestId("bibliometrics-patents-report")).toBeNull();
  });

  it("shows no patents line, count or download when no patent cites the work", async () => {
    respond(12);
    render(<BibliometricsTool entityId="zzz9001" />);
    await screen.findByTestId("bibliometrics-report");
    expect(screen.queryByTestId("bibliometrics-patents")).toBeNull();
    expect(screen.queryByTestId("bibliometrics-patents-download")).toBeNull();
    expect(screen.queryByText(/\d patents?\b/)).toBeNull();
  });

  const headings = () => [...document.querySelectorAll("h3")].map((x) => x.textContent);
  // In the mockup's order; Definitions and sources is the closing <details>, not an h3.
  const SECTIONS = [
    "Summary",
    "Output",
    "Guideline and policy citations",
    "Most impactful papers",
  ];
  const REACH: ScholarReach = {
    note: "What the block counts.",
    lines: [
      { type: "clinical", label: "Clinical studies", papers: 1204, href: "/edit/reports/27?person=zzz9001&stage=any&ctype=clinical&basis=cy" },
      { type: "trial", label: "Registered trials", papers: 0, href: "/edit/reports/27?person=zzz9001&stage=any&ctype=trial&basis=cy" },
      { type: "patent", label: "Patents", papers: 1, href: "/edit/reports/27?person=zzz9001&stage=any&ctype=patent&basis=cy" },
    ],
  };

  const REACH_URL = "/api/edit/bibliometrics?cwid=zzz9001&part=reach";
  /** The report for the report's request, and this for the block's own. */
  function respondWithReach(reach: ScholarReach | null | "fails") {
    fetchMock.mockImplementation(async (url: string) =>
      url !== REACH_URL
        ? { ok: true, json: async () => ({ ok: true, report: report(12) }) }
        : reach === "fails"
          ? { ok: false, status: 500 }
          : { ok: true, json: async () => ({ ok: true, reach }) },
    );
  }
  const reachRequests = () => fetchMock.mock.calls.filter((c) => c[0] === REACH_URL).length;

  it("draws no Downstream reach block, and the same sections as before, when the route sends none", async () => {
    respondWithReach(null);
    render(<BibliometricsTool entityId="zzz9001" />);
    await screen.findByTestId("bibliometrics-report");
    await waitFor(() => expect(reachRequests()).toBe(1));
    expect(screen.queryByTestId("bibliometrics-reach")).toBeNull();
    expect(headings()).toEqual(SECTIONS);
    expect(document.querySelector("details:not([open]) > summary")?.textContent).toContain("Definitions and sources");
    expect(document.body.textContent).not.toContain("Downstream reach");
  });

  it("draws the Downstream reach block the route sends: one line per type, every number a link into report 27", async () => {
    respondWithReach(REACH);
    render(<BibliometricsTool entityId="zzz9001" />);
    const block = await screen.findByTestId("bibliometrics-reach");
    expect(headings()).toEqual([...SECTIONS.slice(0, 3), "Downstream reach", "Most impactful papers"]);
    expect([...block.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("th")?.textContent)).toEqual([
      "Clinical studies",
      "Registered trials",
      "Patents",
    ]);
    // A zero is a line like any other, and still a link to its (empty) list.
    expect(screen.getByRole("link", { name: "0 publications cited by registered trials, in the Downstream reach report" }).textContent).toBe("0");
    // Two columns fit a phone: nothing forces the table wider than its card.
    expect(block.querySelector("table")!.className).not.toContain("min-w-");
    for (const l of REACH.lines) {
      const link = screen.getByTestId(`bibliometrics-reach-${l.type}`);
      expect(link.getAttribute("href")).toBe(l.href);
      expect(link.textContent).toBe(l.papers.toLocaleString());
    }
    // No number in the block outside a link.
    expect([...block.querySelectorAll("td")].every((td) => td.textContent === td.querySelector("a")?.textContent)).toBe(true);
    expect(screen.getByRole("link", { name: "1 publication cited by patents, in the Downstream reach report" })).toBeTruthy();
    expect(block.textContent).toContain(REACH.note);
  });

  it("draws the Connections line the route sends: its number a link to the list, with no stage in its wording", async () => {
    const href = "/edit/reports/27?person=zzz9001&stage=any&basis=cy&view=connections";
    respondWithReach({ ...REACH, connections: { colleagues: 7, href } });
    render(<BibliometricsTool entityId="zzz9001" />);
    const line = await screen.findByTestId("bibliometrics-reach-connections");
    expect(line.textContent).toBe("Colleagues citing this work who have never co-authored with this scholar: 7");
    const link = screen.getByRole("link", {
      name: "7 colleagues citing this work who have never co-authored with this scholar, in the Downstream reach report",
    });
    expect(link.getAttribute("href")).toBe(href);
    expect(link.textContent).toBe("7");
    expect(line.textContent).not.toMatch(/stage/i);
  });

  it("asks for the block once per scholar: a filter change reloads the report and leaves the block alone", async () => {
    respondWithReach(REACH);
    render(<BibliometricsTool entityId="zzz9001" />);
    await screen.findByTestId("bibliometrics-reach");
    fireEvent.click(screen.getByLabelText("First or senior author only"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/edit/bibliometrics?cwid=zzz9001&authorship=lead"),
    );
    expect(reachRequests()).toBe(1);
    expect(screen.getByTestId("bibliometrics-reach")).toBeTruthy();
  });

  it("draws the report without the block when the block's request fails", async () => {
    respondWithReach("fails");
    render(<BibliometricsTool entityId="zzz9001" />);
    await screen.findByTestId("bibliometrics-report");
    await waitFor(() => expect(reachRequests()).toBe(1));
    expect(screen.queryByTestId("bibliometrics-reach")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the report cannot be loaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    render(<BibliometricsTool entityId="zzz9001" />);
    expect(await screen.findByTestId("bibliometrics-error")).toBeTruthy();
  });
});
