/**
 * @vitest-environment jsdom
 *
 * The `/edit` Bibliometrics panel: it renders the section model the route
 * returns, opens a paper's citing documents behind "More", and carries the
 * on-screen filters to the Word download. All people and papers invented.
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/edit/scholar-hover-card", () => ({
  ScholarHoverCard: ({ cwid, children }: { cwid: string; children: React.ReactNode }) => (
    <span data-hover-cwid={cwid}>{children}</span>
  ),
}));

import { BibliometricsTool } from "@/components/edit/bibliometrics-tool";
import { buildBibliometricsReport, type BibliometricsPubRow } from "@/lib/edit/bibliometrics";

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
  position: 1,
  isFirst: true,
  isLast: false,
  ...over,
});

function report(n: number) {
  const pubs = Array.from({ length: n }, (_, i) =>
    pub(i, i === 0 ? { guidelineCount: 1, authorityCount: 1, authorityBodies: [{ body: "WHO", count: 1 }] } : {}),
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

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BibliometricsTool", () => {
  it("renders the report for the scholar it was given", async () => {
    respond(12);
    render(<BibliometricsTool entityId="zzz9001" />);
    const summary = await screen.findByTestId("bibliometrics-summary");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/edit/bibliometrics?cwid=zzz9001");
    expect(summary.textContent).toContain("Jordan Vale has published 12 research articles since 2019");
    expect(summary.querySelector('[data-hover-cwid="zzz9001"]')?.textContent).toBe("Jordan Vale");
    expect(screen.getByText("h-index").previousSibling?.textContent).toBe("12");
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
    expect(screen.getByText("h5-index (last 5 years)")).toBeTruthy();
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

  it("says so when the report cannot be loaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    render(<BibliometricsTool entityId="zzz9001" />);
    expect(await screen.findByTestId("bibliometrics-error")).toBeTruthy();
  });
});
