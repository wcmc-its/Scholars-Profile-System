/**
 * @vitest-environment jsdom
 *
 * The `/edit` Bibliometrics panel: it renders the section model the route
 * returns, opens a paper's citing documents behind "More", and carries the
 * on-screen filters to the Word download. All people and papers invented.
 */
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    expect(screen.getByText("Showing 5 of the top 10 · 12 articles in scope")).toBeTruthy();
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

  it("opens one count's citing documents at a time, counts in a fixed order", async () => {
    const r = report(12);
    const row0 = r.papers.rows[0]!;
    const doc = row0.citing[0]!;
    row0.guidelines = 4;
    row0.citing = [1, 2, 3, 4].map((i) => ({ ...doc, id: i, title: `An invented guideline ${i}` }));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, report: r }) });
    render(<BibliometricsTool entityId="zzz9001" />);
    const row = await screen.findByTestId("bibliometrics-paper-90000100");
    const counts = within(screen.getByTestId("bibliometrics-signals-90000100")).getAllByRole("button");
    // Guidelines before the health authorities; policy sources bold.
    expect(counts.map((b) => b.textContent)).toEqual(["Guidelines 4", "WHO 1"]);
    expect(counts[0]!.className).toContain("font-semibold");
    // A paper with no citing documents says so; a zero count never shows.
    expect(screen.getByTestId("bibliometrics-signals-90000101").textContent).toBe(
      "No guideline, policy or review citations yet",
    );

    fireEvent.click(counts[0]!);
    expect(counts[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(within(row).getByText("4 clinical practice guidelines citing this paper")).toBeTruthy();
    expect(within(row).getAllByRole("link", { name: /An invented guideline/ })).toHaveLength(3);
    expect(within(row).getAllByText("Guideline J · 2022 · guideline")).toHaveLength(3);
    fireEvent.click(within(row).getByRole("button", { name: "See all 4" }));
    expect(within(row).getAllByRole("link", { name: /An invented guideline/ })).toHaveLength(4);

    // Another count replaces the open list; the same count, or ×, closes it.
    fireEvent.click(counts[1]!);
    expect(within(row).queryByRole("link", { name: /An invented guideline/ })).toBeNull();
    expect(within(row).getByText("1 WHO guideline citing this paper")).toBeTruthy();
    fireEvent.click(counts[1]!);
    expect(within(row).queryByText("1 WHO guideline citing this paper")).toBeNull();
    fireEvent.click(counts[0]!);
    fireEvent.click(within(row).getByRole("button", { name: "Close list" }));
    expect(within(row).queryByText(/citing this paper/)).toBeNull();
  });

  it("shows five papers, then all ten; PMID and DOI on their own line; co-authors as text without the scholar", async () => {
    const r = report(12);
    r.papers.rows[0]!.wcmAuthors = [
      { cwid: "zzz9001", name: "Jordan Vale" },
      ...["Avery Marsh", "Blake Okafor", "Casey Quill", "Devon Reyes", "Emery Stone"].map((name, i) => ({
        cwid: `zzz900${i + 2}`,
        name,
      })),
    ];
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, report: r }) });
    render(<BibliometricsTool entityId="zzz9001" />);
    await screen.findByTestId("bibliometrics-paper-90000100");
    const rows = () => document.querySelectorAll('[data-testid^="bibliometrics-paper-"]');
    expect(rows()).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show all 10" }));
    expect(rows()).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Show top 5" })).toBeTruthy();

    const row = screen.getByTestId("bibliometrics-paper-90000100");
    expect(within(row).getByRole("button", { name: "Copy PMID" })).toBeTruthy();
    expect(within(row).getByRole("link", { name: "DOI 10.5555/example.0" })).toBeTruthy();
    const co = within(row).getByText(/WCM co-authors:/);
    expect(co.textContent).toBe("WCM co-authors: Avery Marsh, Blake Okafor, Casey Quill +2 more");
    fireEvent.click(within(co).getByRole("button", { name: "+2 more" }));
    expect(co.textContent).toBe("WCM co-authors: Avery Marsh, Blake Okafor, Casey Quill, Devon Reyes, Emery Stone");
    expect(within(row).getAllByRole("cell")[1]!.textContent).toBe("First");
    expect(screen.getByRole("columnheader", { name: "Cited by (Scopus)" })).toBeTruthy();
  });

  it("marks a percentile early for papers from this year and last, and explains each metric behind an info mark", async () => {
    const r = report(12);
    r.papers.rows[0]!.year = 2025; // asOf is 2026-11-25
    r.papers.rows[1]!.year = 2024;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, report: r }) });
    render(<BibliometricsTool entityId="zzz9001" />);
    const pctl = async (pmid: string) => within(await screen.findByTestId(`bibliometrics-paper-${pmid}`)).getAllByRole("cell")[2]!;
    expect((await pctl("90000100")).textContent).toBe("95.0early");
    expect((await pctl("90000101")).textContent).toBe("94.0");

    expect(screen.queryByText(/relative citation ratio/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "About citation ratio" }));
    expect(await screen.findByText(/relative citation ratio/)).toBeTruthy();
    for (const name of ["About h-index, all publications", "About h5-index, last 5 years", "About NIH percentile", "About Cited by"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("copies a PMID and says Copied for 1.5 s", async () => {
    respond(12);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<BibliometricsTool entityId="zzz9001" />);
    const row = await screen.findByTestId("bibliometrics-paper-90000100");
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(within(row).getByRole("button", { name: "Copy PMID" }));
      });
      expect(writeText).toHaveBeenCalledWith("90000100");
      expect(within(row).getByText("Copied")).toBeTruthy();
      act(() => vi.advanceTimersByTime(1500));
      expect(within(row).queryByText("Copied")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    // Under the paper, behind its Patents count.
    const row = screen.getByTestId("bibliometrics-paper-90000101");
    fireEvent.click(within(row).getByRole("button", { name: "Patents 1" }));
    const below = document.getElementById("bibliometrics-citing-90000101")!;
    expect(within(below).getByText("1 patented invention citing this paper")).toBeTruthy();
    expect(within(below).getByText("Compound and uses")).toBeTruthy();
    expect(within(below).getByText("Example Biotech, Inc. · granted 2022 · US 90000002 B2")).toBeTruthy();
  });

  it("links report 25 from the inventions for a viewer who may open it", async () => {
    respondWithPatents("/edit/reports/patent-citations?person=zzz9001");
    render(<BibliometricsTool entityId="zzz9001" />);
    fireEvent.click(await screen.findByTestId("bibliometrics-inventions-toggle"));
    expect(screen.getByTestId("bibliometrics-patents-report").getAttribute("href")).toBe(
      "/edit/reports/patent-citations?person=zzz9001",
    );
    // Each paper's count is in its impact line, absent for none.
    const signals = (i: number) => screen.getByTestId(`bibliometrics-signals-${90000100 + i}`).textContent ?? "";
    expect(signals(0)).toContain("Patents 14");
    expect(signals(1)).toBe("Patents 1");
    expect(signals(2)).not.toContain("Patents");
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
