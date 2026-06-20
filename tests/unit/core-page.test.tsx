/**
 * The public per-core page body (components/cores/core-page). Renders the
 * facility header + confirmed publications, or an empty state when there are none.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CorePage } from "@/components/cores/core-page";
import type { CorePageData } from "@/lib/api/cores";

const pub = (over: Partial<CorePageData["publications"][number]> = {}) => ({
  pmid: "1",
  title: "MRI study",
  journal: "NeuroImage",
  year: 2021,
  citationCount: 3,
  doi: null,
  pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/1",
  ...over,
});

describe("CorePage", () => {
  it("renders the facility header and confirmed publications", () => {
    const data: CorePageData = {
      core: { id: "2", name: "Biomedical Imaging", facility: "Citigroup Biomedical Imaging Center" },
      publications: [pub({ pmid: "1", title: "MRI study" }), pub({ pmid: "2", title: "fMRI study" })],
    };
    render(<CorePage data={data} />);
    expect(screen.getByRole("heading", { level: 1, name: "Biomedical Imaging" })).toBeTruthy();
    expect(screen.getByText("Citigroup Biomedical Imaging Center")).toBeTruthy();
    expect(screen.getByText("MRI study")).toBeTruthy();
    expect(screen.getByText("fMRI study")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain("Publications (2)");
  });

  it("renders an empty state when there are no confirmed publications", () => {
    const data: CorePageData = {
      core: { id: "9", name: "Genomics", facility: null },
      publications: [],
    };
    render(<CorePage data={data} />);
    expect(screen.getByText("No confirmed publications yet.")).toBeTruthy();
  });
});
