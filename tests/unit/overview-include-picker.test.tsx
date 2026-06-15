/**
 * `components/edit/overview-include-picker.tsx` (#742 v3.1). The controlled
 * source checklists: pre-checks reflect the selection, toggles emit the next
 * selection, the combined 25 / tools-10 caps disable unchecked boxes, search
 * filters publications, and the Methods section is hidden until tools exist.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { OverviewIncludePicker } from "@/components/edit/overview-include-picker";
import type { OverviewSourceOptions } from "@/lib/edit/overview-facts";
import type { OverviewSelection } from "@/lib/edit/overview-params";

function options(over: Partial<OverviewSourceOptions> = {}): OverviewSourceOptions {
  return {
    publications: [
      {
        pmid: "11",
        title: "Batten disease gene therapy",
        venue: "Sci Transl Med",
        year: 2024,
        impact: 92,
        isFirstOrLast: true,
        authorPosition: "first",
        defaultSelected: true,
      },
      {
        pmid: "22",
        title: "PET biodistribution of AAV",
        venue: "Mol Ther",
        year: 2023,
        impact: 78,
        isFirstOrLast: true,
        authorPosition: "last",
        defaultSelected: true,
      },
      {
        pmid: "33",
        title: "Parenchymal gene transfer review",
        venue: "Hum Gene Ther",
        year: 2022,
        impact: 61,
        isFirstOrLast: false,
        authorPosition: "middle",
        defaultSelected: false,
      },
    ],
    funding: [
      {
        id: "g1",
        role: "PI",
        funder: "NIH/NINDS",
        title: "Batten gene therapy",
        award: "R01 NS-1",
        endYear: 2027,
        defaultSelected: true,
      },
      {
        id: "g2",
        role: "Co-I",
        funder: "NIH/NEI",
        title: "Imaging core",
        award: null,
        endYear: 2026,
        defaultSelected: false,
      },
    ],
    tools: [],
    ...over,
  };
}

const sel = (over: Partial<OverviewSelection> = {}): OverviewSelection => ({
  pmids: [],
  grantIds: [],
  toolNames: [],
  ...over,
});

describe("OverviewIncludePicker — rendering & selection", () => {
  it("renders pub + funding rows and reflects the current selection as checked", () => {
    render(
      <OverviewIncludePicker
        options={options()}
        selection={sel({ pmids: ["11"], grantIds: ["g1"] })}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("overview-source-pub-11").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("overview-source-pub-22").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("overview-source-funding-g1").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("shows the §7.2 per-item signals — authorship role · year · impact number", () => {
    render(<OverviewIncludePicker options={options()} selection={sel()} onChange={() => {}} />);
    // Whitelist signals render (year + impact number + role); no model prose.
    expect(screen.getByText(/first author/)).toBeTruthy();
    expect(screen.getByText(/last author/)).toBeTruthy();
    expect(screen.getByText(/impact 92/)).toBeTruthy();
    expect(screen.getByText(/2024/)).toBeTruthy();
  });

  it("links the PMID out to PubMed", () => {
    render(<OverviewIncludePicker options={options()} selection={sel()} onChange={() => {}} />);
    const link = screen.getAllByRole("link", { name: /view on pubmed/i })[0];
    expect(link.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/11/");
  });

  it("toggling a publication emits the next selection (adds the pmid)", () => {
    const onChange = vi.fn();
    render(
      <OverviewIncludePicker
        options={options()}
        selection={sel({ pmids: ["11"] })}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("overview-source-pub-33"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pmids: ["11", "33"] }));
  });

  it("toggling off removes the id", () => {
    const onChange = vi.fn();
    render(
      <OverviewIncludePicker
        options={options()}
        selection={sel({ grantIds: ["g1", "g2"] })}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("overview-source-funding-g1"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ grantIds: ["g2"] }));
  });
});

describe("OverviewIncludePicker — search", () => {
  it("filters publications by title/venue", () => {
    render(<OverviewIncludePicker options={options()} selection={sel()} onChange={() => {}} />);
    fireEvent.change(screen.getByTestId("overview-source-search"), { target: { value: "PET" } });
    expect(screen.getByTestId("overview-source-pub-22")).toBeTruthy();
    expect(screen.queryByTestId("overview-source-pub-11")).toBeNull();
  });
});

describe("OverviewIncludePicker — caps", () => {
  it("disables unchecked pub/funding boxes at the combined 25 cap (checked stay enabled)", () => {
    // 26 pubs; select the first 25 → the 26th's box disables, a selected one does not.
    const pubs = Array.from({ length: 26 }, (_, i) => ({
      pmid: `p${i}`,
      title: `Paper ${i}`,
      venue: "Journal",
      year: 2020,
      impact: 50,
      isFirstOrLast: true,
      authorPosition: "first" as const,
      defaultSelected: false,
    }));
    const selected = pubs.slice(0, 25).map((p) => p.pmid);
    render(
      <OverviewIncludePicker
        options={options({ publications: pubs, funding: [] })}
        selection={sel({ pmids: selected })}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("overview-source-pub-p25").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("overview-source-pub-p0").hasAttribute("disabled")).toBe(false);
  });
});

describe("OverviewIncludePicker — Methods section (hidden when no families)", () => {
  it("is hidden entirely when there are no tools", () => {
    render(
      <OverviewIncludePicker
        options={options({ tools: [] })}
        selection={sel()}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByTestId("overview-source-methods")).toBeNull();
  });

  it("renders tool rows + the 10-cap counter when tools exist", () => {
    render(
      <OverviewIncludePicker
        options={options({
          tools: [
            {
              toolName: "AAV vectors",
              category: "vector platform",
              pmidCount: 28,
              maxConfidence: 0.9,
              defaultSelected: true,
            },
            {
              toolName: "PET imaging",
              category: "imaging",
              pmidCount: 12,
              maxConfidence: 0.8,
              defaultSelected: true,
            },
          ],
        })}
        selection={sel({ toolNames: ["AAV vectors"] })}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("overview-source-methods")).toBeTruthy();
    expect(
      screen.getByTestId("overview-source-tool-AAV vectors").getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByTestId("overview-source-tools-counter").textContent).toContain("1 / 10");
  });

  it("disables unchecked tool boxes at the 10 cap", () => {
    const tools = Array.from({ length: 11 }, (_, i) => ({
      toolName: `tool${i}`,
      category: "method",
      pmidCount: 5,
      maxConfidence: 0.5,
      defaultSelected: false,
    }));
    render(
      <OverviewIncludePicker
        options={options({ tools })}
        selection={sel({ toolNames: tools.slice(0, 10).map((t) => t.toolName) })}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("overview-source-tool-tool10").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("overview-source-tool-tool0").hasAttribute("disabled")).toBe(false);
  });

  it("shows the method's publication count only — never model prose (§7.2)", () => {
    render(
      <OverviewIncludePicker
        options={options({
          tools: [
            {
              toolName: "AAV vectors",
              category: "vector platform",
              pmidCount: 16,
              maxConfidence: 0.9,
              defaultSelected: true,
            },
          ],
        })}
        selection={sel()}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("16 publications")).toBeTruthy();
  });
});

describe("OverviewIncludePicker — §7.1 rule lines + §5 sort control", () => {
  it("renders each section's verbatim rule line", () => {
    render(
      <OverviewIncludePicker
        options={options({
          tools: [
            { toolName: "AAV", category: "v", pmidCount: 5, maxConfidence: 0.9, defaultSelected: true },
          ],
        })}
        selection={sel()}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByText(
        "Ranked by citation impact and recency, weighted toward senior-author work.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Ranked by your role and recency.")).toBeTruthy();
    expect(
      screen.getByText(
        "Inferred from methods named in your publications · ranked by how often each appears.",
      ),
    ).toBeTruthy();
  });

  it("offers a publications sort control (impact / year) that coexists with the rule line", () => {
    render(<OverviewIncludePicker options={options()} selection={sel()} onChange={() => {}} />);
    const sortControl = screen.getByTestId("overview-source-pub-sort");
    expect(sortControl).toBeTruthy();
    // Both the rule line AND the sort control are present in the same section.
    expect(
      screen.getByText(
        "Ranked by citation impact and recency, weighted toward senior-author work.",
      ),
    ).toBeTruthy();
  });

  it("never renders model prose (synopsis / impactJustification / sampleContext) next to an item", () => {
    const { container } = render(
      <OverviewIncludePicker options={options()} selection={sel({ pmids: ["11"] })} onChange={() => {}} />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/synopsis|justification|impactJustification|sampleContext|context:/i);
  });
});

describe("OverviewIncludePicker — selected-first ordering", () => {
  it("pins checked publications to the top of the list", () => {
    render(
      <OverviewIncludePicker
        options={options()}
        selection={sel({ pmids: ["33"] })}
        onChange={() => {}}
      />,
    );
    // Only the per-row checkboxes (the sort control is `overview-source-pub-sort`).
    const boxes = screen.getAllByTestId(/^overview-source-pub-\d+$/);
    // pmid 33 is the lowest-impact / middle author but it is selected → top.
    expect(boxes[0].getAttribute("data-testid")).toBe("overview-source-pub-33");
  });
});

describe("OverviewIncludePicker — quick actions", () => {
  it("None clears the publications selection", () => {
    const onChange = vi.fn();
    render(
      <OverviewIncludePicker
        options={options()}
        selection={sel({ pmids: ["11", "22"] })}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("overview-source-none-pub"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pmids: [] }));
  });

  it("All selects every publication within the combined cap", () => {
    const onChange = vi.fn();
    render(<OverviewIncludePicker options={options()} selection={sel()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("overview-source-all-pub"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ pmids: ["11", "22", "33"] }),
    );
  });

  it("Top 10 by score for Methods honors the pmid_count >= 2 floor", () => {
    const onChange = vi.fn();
    render(
      <OverviewIncludePicker
        options={options({
          tools: [
            { toolName: "frequent", category: "m", pmidCount: 8, maxConfidence: 0.9, defaultSelected: true },
            { toolName: "rare", category: "m", pmidCount: 1, maxConfidence: 0.8, defaultSelected: false },
          ],
        })}
        selection={sel()}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("overview-source-topn-tool"));
    // The single-paper "rare" family is excluded by the floor.
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ toolNames: ["frequent"] }));
  });
});
