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

  it("names example single-paper methods in the '+ N more' copy", () => {
    const opts = options({
      tools: [
        { toolName: "Survival analysis", category: null, pmidCount: 2, maxConfidence: 0.9, defaultSelected: true },
        { toolName: "Echocardiography", category: null, pmidCount: 1, maxConfidence: 0.6, defaultSelected: false },
      ],
    });
    render(<OverviewIncludePicker options={opts} deltas={deltas()} onChange={() => {}} />);
    expect(screen.getByTestId("overview-source-section-method").textContent).toContain(
      "(Echocardiography…)",
    );
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

  it("keeps the only led grant visible (struck + Undo) when excluded — NOT the empty state", () => {
    // Regression: the empty-led copy is about candidates, not the veto state.
    render(
      <OverviewIncludePicker
        options={options()}
        deltas={deltas({ excluded: { funding: ["g1"] } })}
        onChange={() => {}}
      />,
    );
    const row = screen.getByTestId("overview-source-row-funding-g1");
    expect(row.getAttribute("data-state")).toBe("excluded");
    expect(screen.getByTestId("overview-source-undo-funding-g1")).toBeTruthy();
    expect(screen.queryByTestId("overview-source-empty-led")).toBeNull();
  });

  it("keeps an excluded middle-author paper reachable (struck + Undo) in 'led' mode", () => {
    // Regression: an excluded mid-bucket record must not vanish with its Undo.
    render(
      <OverviewIncludePicker
        options={options()}
        deltas={deltas({ excluded: { publication: ["44"] } })}
        onChange={() => {}}
      />,
    );
    const row = screen.getByTestId("overview-source-row-publication-44");
    expect(row.getAttribute("data-state")).toBe("excluded");
    expect(screen.getByTestId("overview-source-undo-publication-44")).toBeTruthy();
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

describe("OverviewIncludePicker — titles & education (#742 §7)", () => {
  const richOpts = () =>
    options({
      identity: {
        name: "Jane Smith",
        primaryTitle: "Associate Professor of Medicine",
        primaryDepartment: "Medicine",
      },
      titles: [
        { id: "a0", title: "Associate Professor of Medicine", organization: "Weill Cornell Medicine", isPrimary: true, isInterim: false, isCurrent: true, endYear: null, featured: true, reason: "Your primary appointment" },
        { id: "a1", title: "Chief, Division of Hematology", organization: "Weill Cornell Medicine", isPrimary: false, isInterim: false, isCurrent: true, endYear: null, featured: true, reason: "A leadership role" },
        { id: "a2", title: "Attending Physician", organization: "NewYork-Presbyterian", isPrimary: false, isInterim: false, isCurrent: true, endYear: null, featured: false, reason: "A current appointment" },
      ],
      education: [
        { id: "e1", degree: "M.D.", institution: "Yale School of Medicine", field: null, year: 2005, featured: true, reason: "Terminal degree" },
        { id: "e2", degree: "Certificate in Clinical Research", institution: "WCM", field: null, year: 2010, featured: false, reason: "Training / certificate" },
      ],
    });

  it("renders the scaffold as name · primary title · department (the strings the bio grounds on)", () => {
    render(<OverviewIncludePicker options={richOpts()} deltas={deltas()} onChange={() => {}} />);
    const scaffold = screen.getByTestId("overview-source-scaffold-title");
    expect(scaffold.textContent).toContain("Always shown");
    expect(scaffold.textContent).toContain("Jane Smith · Associate Professor of Medicine · Medicine");
    // The primary appointment is the scaffold, never a toggleable row.
    expect(screen.queryByTestId("overview-source-row-title-a0")).toBeNull();
  });

  it("shows the Titles section (no scaffold) when there are roles but no resolved primary title", () => {
    const opts = options({
      identity: { name: "Jane Smith", primaryTitle: null, primaryDepartment: "Medicine" },
      titles: [
        { id: "a1", title: "Chief, Division of Hematology", organization: "Weill Cornell Medicine", isPrimary: false, isInterim: false, isCurrent: true, endYear: null, featured: true, reason: "A leadership role" },
      ],
    });
    render(<OverviewIncludePicker options={opts} deltas={deltas()} onChange={() => {}} />);
    expect(screen.getByTestId("overview-source-section-title")).toBeTruthy();
    expect(screen.queryByTestId("overview-source-scaffold-title")).toBeNull();
    expect(screen.getByTestId("overview-source-row-title-a1")).toBeTruthy();
  });

  it("renders a pre-excluded title struck-through with an Undo (not vanished)", () => {
    render(
      <OverviewIncludePicker
        options={richOpts()}
        deltas={deltas({ excluded: { title: ["a1"] } })}
        onChange={() => {}}
      />,
    );
    const row = screen.getByTestId("overview-source-row-title-a1");
    expect(row.getAttribute("data-state")).toBe("excluded");
    expect(screen.getByTestId("overview-source-undo-title-a1")).toBeTruthy();
  });

  it("gives a pinned Available title an Unpin (clean un-add, not a spurious hide)", () => {
    const onChange = vi.fn();
    render(
      <OverviewIncludePicker
        options={richOpts()}
        deltas={deltas({ pinned: { title: ["a2"] } })}
        onChange={onChange}
      />,
    );
    // a2 is an Available (non-featured) row pinned in → exclude-only section, so it gets
    // an Unpin control, and clicking it clears the pin rather than minting an exclude.
    fireEvent.click(screen.getByTestId("overview-source-pin-title-a2"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        pinned: expect.not.objectContaining({ title: expect.anything() }),
        excluded: expect.not.objectContaining({ title: expect.anything() }),
      }),
    );
  });

  it("renders a past-role title's 'until <year>' meta and suppresses a null education year", () => {
    const opts = options({
      identity: { name: "Jane Smith", primaryTitle: "Professor", primaryDepartment: "Medicine" },
      titles: [
        { id: "a3", title: "Former Director, Genomics Core", organization: "WCM", isPrimary: false, isInterim: false, isCurrent: false, endYear: 2019, featured: false, reason: "A past leadership role" },
      ],
      education: [
        { id: "e3", degree: "M.D.", institution: "Some University", field: null, year: null, featured: true, reason: "Terminal degree" },
      ],
    });
    render(<OverviewIncludePicker options={opts} deltas={deltas()} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId("overview-source-more-title"));
    expect(screen.getByTestId("overview-source-row-title-a3").textContent).toContain("until 2019");
    const eduRow = screen.getByTestId("overview-source-row-education-e3");
    expect(eduRow.textContent).toContain("Some University");
    expect(eduRow.textContent).not.toContain("null");
  });

  it("features the significant current role exclude-only (no pin); the rest sits behind '+ more'", () => {
    render(<OverviewIncludePicker options={richOpts()} deltas={deltas()} onChange={() => {}} />);
    expect(screen.getByTestId("overview-source-row-title-a1")).toBeTruthy();
    expect(screen.getByTestId("overview-source-exclude-title-a1")).toBeTruthy();
    expect(screen.queryByTestId("overview-source-pin-title-a1")).toBeNull();
    expect(screen.queryByTestId("overview-source-row-title-a2")).toBeNull();
    expect(screen.getByTestId("overview-source-more-title")).toBeTruthy();
  });

  it("excludes a featured title and adds an Available one (add-and-pin)", () => {
    const onChange = vi.fn();
    render(<OverviewIncludePicker options={richOpts()} deltas={deltas()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("overview-source-exclude-title-a1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ excluded: expect.objectContaining({ title: ["a1"] }) }),
    );
    fireEvent.click(screen.getByTestId("overview-source-more-title"));
    fireEvent.click(screen.getByTestId("overview-source-add-title-a2"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: expect.objectContaining({ title: ["a2"] }) }),
    );
  });

  it("features terminal/professional education exclude-only; the minor cert sits behind '+ more'", () => {
    render(<OverviewIncludePicker options={richOpts()} deltas={deltas()} onChange={() => {}} />);
    expect(screen.getByTestId("overview-source-row-education-e1")).toBeTruthy();
    expect(screen.getByTestId("overview-source-exclude-education-e1")).toBeTruthy();
    expect(screen.queryByTestId("overview-source-pin-education-e1")).toBeNull();
    expect(screen.queryByTestId("overview-source-row-education-e2")).toBeNull();
    expect(screen.getByTestId("overview-source-more-education")).toBeTruthy();
  });

  it("hides both sections when the scholar has no titles or education", () => {
    render(<OverviewIncludePicker options={options()} deltas={deltas()} onChange={() => {}} />);
    expect(screen.queryByTestId("overview-source-section-title")).toBeNull();
    expect(screen.queryByTestId("overview-source-section-education")).toBeNull();
  });
});
