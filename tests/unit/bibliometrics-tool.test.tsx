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
  it("lists a stage's papers when its count is selected, and links report 26 only when allowed", async () => {
    const pubs = [
      pub(1, { translationalStage: "T2", translationalStageConfidence: "high", title: "A staged paper" }),
      pub(2, { translationalStage: null }),
    ];
    const r = buildBibliometricsReport({
      scholar: { cwid: "zzz9001", name: "Jordan Vale", hIndex: 12 },
      visible: pubs,
      all: pubs,
      filters: { authorship: "all", yearFrom: null, yearTo: null },
      now: new Date("2026-11-25T12:00:00Z"),
      stagesEnabled: true,
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, report: r }) });
    render(<BibliometricsTool entityId="zzz9001" />);
    const section = await screen.findByTestId("bibliometrics-stages");
    // One staged paper of two: T2 is 100% of the papers WITH a stage; No stage has no share.
    expect(section.textContent).toContain("100%");
    expect(section.textContent).not.toContain("50%");
    expect(screen.queryByText("Full translational profile", { exact: false })).toBeNull();
    const counts = section.querySelectorAll("button[aria-expanded]");
    expect(counts).toHaveLength(2); // T2 and No stage; zero rows are not buttons
    const listed = () => within(section).queryByRole("link", { name: "A staged paper" });
    expect(listed()).toBeNull();
    fireEvent.click(counts[0]!);
    expect(counts[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(listed()).toBeTruthy();
    cleanup();
    r.stages!.portfolioHref = "/edit/scholar/zzz9001/translational-portfolio";
    render(<BibliometricsTool entityId="zzz9001" />);
    expect((await screen.findByText("Full translational profile", { exact: false })).getAttribute("href")).toBe(
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
    // Every section; the h-index and h5 tiles say "all publications".
    expect(marked).toEqual(["Summary", "Output", "Downstream impact", "Most impactful papers"]);
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

  it("puts policy, research and invention citations in one Downstream impact table; each Articles cited count lists its articles", async () => {
    const pubs = [
      pub(0, {
        title: "A guideline paper",
        guidelineCount: 1,
        authorityCount: 1,
        authorityBodies: [{ body: "WHO", count: 1 }],
        clinicalCiteCount: 3,
      }),
      pub(1, { title: "A trial paper", year: 2021, trialCount: 2, clinicalCiteCount: 1 }),
      pub(2),
    ];
    const r = buildBibliometricsReport({
      scholar: { cwid: "zzz9001", name: "Jordan Vale", hIndex: 12 },
      visible: pubs,
      all: pubs,
      filters: { authorship: "all", yearFrom: null, yearTo: null },
      now: new Date("2026-11-25T12:00:00Z"),
    });
    r.policy[0]!.bodies = [{ body: "WHO", count: 4 }];
    r.research.clinical.documents = 5; // the loader's distinct count
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, report: r }) });
    render(<BibliometricsTool entityId="zzz9001" />);
    const impact = await screen.findByTestId("bibliometrics-impact");
    expect([...impact.querySelectorAll('th[scope="colgroup"]')].map((th) => th.textContent)).toEqual([
      "Policy and practice",
      "Research by others",
      "Invention",
    ]);
    const line = (label: string) =>
      [...impact.querySelectorAll('tbody th[scope="row"]')].find((th) => th.textContent!.startsWith(label))!.closest("tr")!;
    expect(line("Health authorities").textContent).toContain("WHO 4");
    expect(line("Clinical studies").textContent).toBe("Clinical studies (excluding the article\u2019s own authors)25");
    // A zero is plain text, never a button.
    expect(within(line("Consensus statements")).queryByRole("button")).toBeNull();

    fireEvent.click(screen.getByTestId("bibliometrics-cited-clinical"));
    expect(within(impact).getByRole("link", { name: "A trial paper" })).toBeTruthy(); // newest first
    expect(within(impact).getByRole("link", { name: "A guideline paper" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("bibliometrics-cited-trial"));
    expect(within(impact).queryByRole("link", { name: "A guideline paper" })).toBeNull();
    expect(within(impact).getByRole("link", { name: "A trial paper" })).toBeTruthy();
    // Nothing of the three old sections is left.
    expect(screen.queryByText("Guideline and policy citations")).toBeNull();
    expect(screen.queryByText("Patents citing this work")).toBeNull();
  });

  it("lists the citing inventions newest first under the Patents row, each with the paper it cites", async () => {
    const r = report(12, [14, 1]);
    const inv = (id: number, title: string, papers: number, pmids: string[] = []) => ({
      id,
      title,
      url: `https://patents.google.com/patent/US9000000${id}B2/en`,
      holder: "Example Biotech, Inc.",
      year: 2020 + id,
      granted: true,
      number: `US 9000000${id} B2`,
      related: 0,
      papers,
      pmids,
    });
    const list = [
      inv(5, "Sensor housing", 1, ["90000101"]),
      inv(4, "Assay kit", 1, ["90000101"]),
      inv(3, "Dosing regimen", 1, ["90000100"]),
      inv(2, "Compound and uses", 1, ["90000101"]),
      inv(1, "Widget calibration", 2, ["90000100", "90000101"]),
    ];
    r.patents = { ...r.patents, inventions: 5, dataEnd: "31 December 2025", reportHref: null, list };
    r.papers.rows[1]!.citingPatents = { items: [inv(2, "Compound and uses", 1)], total: 1 };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, report: r }) });
    render(<BibliometricsTool entityId="zzz9001" />);
    const impact = await screen.findByTestId("bibliometrics-impact");
    expect(impact.textContent).toContain("Patents (patent data through 31 December 2025)");
    expect(screen.queryByTestId("bibliometrics-inventions")).toBeNull();
    fireEvent.click(screen.getByTestId("bibliometrics-inventions-toggle"));
    const panel = screen.getByTestId("bibliometrics-inventions");
    expect(within(panel).getAllByRole("listitem").map((li) => li.querySelector("a")!.textContent)).toEqual([
      "Sensor housing",
      "Assay kit",
      "Dosing regimen",
    ]);
    fireEvent.click(within(panel).getByRole("button", { name: "Show all 5" }));
    const widget = within(panel).getByText("Widget calibration").closest("li")!;
    expect(widget.querySelector("a")!.getAttribute("href")).toBe("https://patents.google.com/patent/US90000001B2/en");
    expect(widget.textContent).toBe(
      "Widget calibrationExample Biotech, Inc. · granted 2021 · US 90000001 B2 · cites Invented paper 0 and 1 more paper",
    );
    expect(within(panel).getByText("Dosing regimen").closest("li")!.textContent).toContain("cites Invented paper 0");
    // The download for every viewer; report 25 only for one who may open it.
    expect(within(panel).getByTestId("bibliometrics-patents-download").getAttribute("href")).toBe(
      "/api/edit/bibliometrics/patents?cwid=zzz9001",
    );
    expect(within(panel).queryByTestId("bibliometrics-patents-report")).toBeNull();
    // Under the paper, behind "More", as the publication modal lists them.
    const row = screen.getByTestId("bibliometrics-paper-90000101");
    fireEvent.click(within(row).getByRole("button", { name: "More" }));
    expect(within(document.getElementById("bibliometrics-citing-90000101")!).getByText("Compound and uses")).toBeTruthy();
  });

  it("links report 25 from the inventions for a viewer who may open it", async () => {
    respondWithPatents("/edit/reports/patent-citations?person=zzz9001");
    render(<BibliometricsTool entityId="zzz9001" />);
    fireEvent.click(await screen.findByTestId("bibliometrics-inventions-toggle"));
    expect(screen.getByTestId("bibliometrics-patents-report").getAttribute("href")).toBe(
      "/edit/reports/patent-citations?person=zzz9001",
    );
  });

  it("shows zero inventions and no toggle or download when no patent cites the work", async () => {
    respond(12);
    render(<BibliometricsTool entityId="zzz9001" />);
    const impact = await screen.findByTestId("bibliometrics-impact");
    expect(impact.textContent).toContain("0 inventions");
    expect(screen.queryByTestId("bibliometrics-inventions-toggle")).toBeNull();
    expect(screen.queryByTestId("bibliometrics-patents-download")).toBeNull();
  });

  const headings = () => [...document.querySelectorAll("h3")].map((x) => x.textContent);
  // In the mockup's order; Definitions and sources is the closing <details>, not an h3.
  const SECTIONS = ["Summary", "Output", "Downstream impact", "Most impactful papers"];
  const REACH: ScholarReach = {
    note: "What the block counts.",
    lines: [
      { type: "clinical", label: "Clinical studies", papers: 1204, href: "/edit/reports/27?person=zzz9001&stage=any&ctype=clinical&basis=cy" },
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
  const CONNECTIONS = { colleagues: 7, href: "/edit/reports/27?person=zzz9001&stage=any&basis=cy&view=connections" };

  it("draws the same sections, and no report 27 lines, whatever the route sends", async () => {
    respondWithReach(REACH);
    render(<BibliometricsTool entityId="zzz9001" />);
    await screen.findByTestId("bibliometrics-report");
    await waitFor(() => expect(reachRequests()).toBe(1));
    expect(headings()).toEqual(SECTIONS);
    expect(document.querySelector("details:not([open]) > summary")?.textContent).toContain("Definitions and sources");
    // The counts are the table's own now: report 27 lines would count other publication types.
    expect(screen.queryByText("1,204")).toBeNull();
  });

  it("draws the Connections line the route sends under Downstream impact: its number a link to the list", async () => {
    respondWithReach({ ...REACH, connections: CONNECTIONS });
    render(<BibliometricsTool entityId="zzz9001" />);
    const line = await screen.findByTestId("bibliometrics-reach-connections");
    expect(line.closest('[data-testid="bibliometrics-impact"]')).toBeTruthy();
    expect(line.textContent).toBe("Colleagues citing this work who have never co-authored with this scholar: 7");
    const link = screen.getByRole("link", {
      name: "7 colleagues citing this work who have never co-authored with this scholar, in the Downstream reach report",
    });
    expect(link.getAttribute("href")).toBe(CONNECTIONS.href);
    expect(line.textContent).not.toMatch(/stage/i);
  });

  it("asks for the Connections line once per scholar: a filter change reloads the report and leaves it alone", async () => {
    respondWithReach({ ...REACH, connections: CONNECTIONS });
    render(<BibliometricsTool entityId="zzz9001" />);
    await screen.findByTestId("bibliometrics-reach-connections");
    fireEvent.click(screen.getByLabelText("First or senior author only"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/edit/bibliometrics?cwid=zzz9001&authorship=lead"),
    );
    expect(reachRequests()).toBe(1);
    expect(screen.getByTestId("bibliometrics-reach-connections")).toBeTruthy();
  });

  it("draws the report without the block when the block's request fails", async () => {
    respondWithReach("fails");
    render(<BibliometricsTool entityId="zzz9001" />);
    await screen.findByTestId("bibliometrics-report");
    await waitFor(() => expect(reachRequests()).toBe(1));
    expect(screen.queryByTestId("bibliometrics-reach-connections")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the report cannot be loaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    render(<BibliometricsTool entityId="zzz9001" />);
    expect(await screen.findByTestId("bibliometrics-error")).toBeTruthy();
  });
});
