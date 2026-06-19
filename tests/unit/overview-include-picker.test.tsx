/**
 * `components/edit/overview-include-picker.tsx` (#742 §2 / Phase 2). The
 * three-state source picker: featured rows pin / exclude, the Available tail
 * reveals behind "+ more" or the led ⇄ all toggle and offers "add and pin",
 * excluded rows strike through and offer Undo, and every action emits the next
 * {@link OverviewSelectionDeltas}. Methods hide when the scholar has no families.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { OverviewIncludePicker } from "@/components/edit/overview-include-picker";
import type { OverviewSourceOptions } from "@/lib/edit/overview-facts";
import {
  DEFAULT_OVERVIEW_SELECTION_DELTAS,
  type OverviewSelectionDeltas,
} from "@/lib/edit/overview-params";

function options(over: Partial<OverviewSourceOptions> = {}): OverviewSourceOptions {
  return {
    publications: [
      // featured (first author, in the auto-set)
      { pmid: "11", title: "Batten disease gene therapy", venue: "Sci Transl Med", year: 2024, impact: 92, isFirstOrLast: true, authorPosition: "first", defaultSelected: true, reason: "Recent first-author trial." },
      // featured (last author)
      { pmid: "22", title: "PET biodistribution of AAV", venue: "Mol Ther", year: 2023, impact: 78, isFirstOrLast: true, authorPosition: "last", defaultSelected: true },
      // "more" — first/last but NOT in the auto-set (behind "+ more")
      { pmid: "33", title: "Vector serotype comparison", venue: "Hum Gene Ther", year: 2021, impact: 40, isFirstOrLast: true, authorPosition: "first", defaultSelected: false },
      // "mid" — middle author (behind "all positions")
      { pmid: "44", title: "Parenchymal gene transfer review", venue: "Hum Gene Ther", year: 2022, impact: 61, isFirstOrLast: false, authorPosition: "middle", defaultSelected: false },
    ],
    funding: [
      { id: "g1", role: "PI", funder: "NIH/NINDS", title: "Batten gene therapy", award: "R01 NS-1", endYear: 2027, defaultSelected: true },
      // co-I — behind "all roles"
      { id: "g2", role: "Co-I", funder: "NIH/NEI", title: "Imaging core", award: null, endYear: 2026, defaultSelected: false },
    ],
    tools: [],
    ...over,
  };
}

function deltas(over: Partial<OverviewSelectionDeltas> = {}): OverviewSelectionDeltas {
  return { ...DEFAULT_OVERVIEW_SELECTION_DELTAS, ...over };
}

describe("OverviewIncludePicker — tiers", () => {
  it("shows featured rows and hides the Available tail (more / mid) by default", () => {
    render(<OverviewIncludePicker options={options()} deltas={deltas()} onChange={() => {}} />);
    expect(screen.getByTestId("overview-source-row-publication-11")).toBeTruthy();
    expect(screen.getByTestId("overview-source-row-publication-22")).toBeTruthy();
    // "more" and "mid" buckets are hidden until revealed.
    expect(screen.queryByTestId("overview-source-row-publication-33")).toBeNull();
    expect(screen.queryByTestId("overview-source-row-publication-44")).toBeNull();
    // The "+ N more" affordance counts the hidden "more" bucket (pmid 33).
    expect(screen.getByTestId("overview-source-more-publication")).toBeTruthy();
  });

  it("reveals the 'more' tail on show, with add-and-pin controls", () => {
    render(<OverviewIncludePicker options={options()} deltas={deltas()} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId("overview-source-more-publication"));
    const row = screen.getByTestId("overview-source-row-publication-33");
    expect(row).toBeTruthy();
    // Available rows get "add and pin", not pin + exclude.
    expect(screen.getByTestId("overview-source-add-publication-33")).toBeTruthy();
    expect(screen.queryByTestId("overview-source-exclude-publication-33")).toBeNull();
  });

  it("hides the Methods section when the scholar has no families", () => {
    render(<OverviewIncludePicker options={options()} deltas={deltas()} onChange={() => {}} />);
    expect(screen.queryByTestId("overview-source-section-method")).toBeNull();
  });

  it("shows the Methods section with usage evidence when tools exist", () => {
    const opts = options({
      tools: [
        { toolName: "AAV vectors", category: "vector", pmidCount: 12, maxConfidence: 0.9, defaultSelected: true, reason: "…delivered the transgene to retinal cells." },
      ],
    });
    render(<OverviewIncludePicker options={opts} deltas={deltas()} onChange={() => {}} />);
    expect(screen.getByTestId("overview-source-section-method")).toBeTruthy();
    fireEvent.click(screen.getByTestId("overview-source-why-method-AAV vectors"));
    expect(screen.getByText(/delivered the transgene/)).toBeTruthy();
  });
});

describe("OverviewIncludePicker — three-state actions", () => {
  it("pins a featured publication (pin-to-protect)", () => {
    const onChange = vi.fn();
    render(<OverviewIncludePicker options={options()} deltas={deltas()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("overview-source-pin-publication-11"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: expect.objectContaining({ publication: ["11"] }) }),
    );
  });

  it("excludes a featured publication (the veto)", () => {
    const onChange = vi.fn();
    render(<OverviewIncludePicker options={options()} deltas={deltas()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("overview-source-exclude-publication-22"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ excluded: expect.objectContaining({ publication: ["22"] }) }),
    );
  });

  it("strikes through an excluded row and offers Undo", () => {
    const onChange = vi.fn();
    render(
      <OverviewIncludePicker
        options={options()}
        deltas={deltas({ excluded: { publication: ["11"] } })}
        onChange={onChange}
      />,
    );
    const row = screen.getByTestId("overview-source-row-publication-11");
    expect(row.getAttribute("data-state")).toBe("excluded");
    fireEvent.click(screen.getByTestId("overview-source-undo-publication-11"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ excluded: expect.not.objectContaining({ publication: expect.anything() }) }),
    );
  });

  it("'add and pin' on a revealed Available row pins it", () => {
    const onChange = vi.fn();
    render(<OverviewIncludePicker options={options()} deltas={deltas()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("overview-source-more-publication"));
    fireEvent.click(screen.getByTestId("overview-source-add-publication-33"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: expect.objectContaining({ publication: ["33"] }) }),
    );
  });
});

describe("OverviewIncludePicker — led ⇄ all toggle", () => {
  it("switching to 'all positions' updates the deltas toggle", () => {
    const onChange = vi.fn();
    render(<OverviewIncludePicker options={options()} deltas={deltas()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("overview-source-toggle-publication-all"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ publicationPositions: "all" }),
    );
  });

  it("'all positions' reveals the middle-author tail", () => {
    render(
      <OverviewIncludePicker
        options={options()}
        deltas={deltas({ publicationPositions: "all" })}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("overview-source-row-publication-44")).toBeTruthy();
  });

  it("shows funding's 'no grants you lead' empty state when led and none are featured", () => {
    const opts = options({
      funding: [
        { id: "g2", role: "Co-I", funder: "NIH", title: "Imaging core", award: null, endYear: 2026, defaultSelected: false },
      ],
    });
    render(<OverviewIncludePicker options={opts} deltas={deltas()} onChange={() => {}} />);
    expect(screen.getByTestId("overview-source-empty-led")).toBeTruthy();
  });
});

describe("OverviewIncludePicker — thin-overview warning", () => {
  it("warns when fewer than 3 publications are visible", () => {
    // Two featured pubs (11, 22) → below the floor.
    render(<OverviewIncludePicker options={options()} deltas={deltas()} onChange={() => {}} />);
    expect(screen.getByTestId("overview-source-minwarn")).toBeTruthy();
  });

  it("clears the warning once a third paper is pinned in", () => {
    render(
      <OverviewIncludePicker
        options={options()}
        deltas={deltas({ pinned: { publication: ["44"] } })}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByTestId("overview-source-minwarn")).toBeNull();
  });
});

describe("OverviewIncludePicker — publications sort", () => {
  it("opens the sort menu and reorders by most recent", () => {
    render(<OverviewIncludePicker options={options()} deltas={deltas()} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId("overview-source-pub-sortctl"));
    fireEvent.click(screen.getByTestId("overview-source-pub-sort-most-recent"));
    // 2024 (pmid 11) sorts ahead of 2023 (pmid 22).
    const rows = screen.getAllByTestId(/overview-source-row-publication-/);
    expect(rows[0].getAttribute("data-testid")).toBe("overview-source-row-publication-11");
  });
});
