import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaxonomyRail, type TaxonomyRailProps } from "@/components/taxonomy/taxonomy-rail";

const subtopics = [
  { id: "s1", label: "Cardiac Surgery", displayName: "Cardiac Surgery", description: null, shortDescription: "Procedures on the heart and great vessels", pubCount: 234 },
  { id: "s2", label: "Oncology", displayName: "Oncology", description: null, shortDescription: null, pubCount: 50 },
  { id: "s3", label: "Gene Therapy", displayName: "Gene Therapy", description: null, shortDescription: "Therapeutic delivery of genetic material", pubCount: 10 },
  { id: "s4", label: "Case Reports", displayName: "Case Reports", description: null, shortDescription: null, pubCount: 3 },
];

type Sub = (typeof subtopics)[number];

/** The topic page's rail configuration (mirrors TopicRailLayout). */
function SubtopicRail({
  subtopics: subs,
  activeSubtopic,
  onSelect,
  allRow,
}: {
  subtopics: Sub[];
  activeSubtopic: string | null;
  onSelect: (id: string | null) => void;
  allRow?: TaxonomyRailProps["allRow"];
}) {
  return (
    <TaxonomyRail
      items={subs.map((s) => ({ id: s.id, label: s.displayName, count: s.pubCount }))}
      selectedId={activeSubtopic}
      onSelect={onSelect}
      railLabel="Subareas"
      headerText={`SUBAREAS (${subs.length})`}
      filterPlaceholder="Filter subareas…"
      noMatchNoun="subareas"
      lessCommonThreshold={10}
      variant="plain"
      allRow={allRow}
    />
  );
}

describe("TaxonomyRail (subarea configuration)", () => {
  it("renders all subtopic display names on the top line", () => {
    render(<SubtopicRail subtopics={subtopics} activeSubtopic={null} onSelect={() => {}} />);
    expect(screen.getByText("Cardiac Surgery")).toBeTruthy();
    expect(screen.getByText("Oncology")).toBeTruthy();
    expect(screen.getByText("Gene Therapy")).toBeTruthy();
    expect(screen.getByText("Case Reports")).toBeTruthy();
  });

  it("renders subtopics in the order provided (sorted DESC by pubCount expected from API)", () => {
    const { container } = render(
      <SubtopicRail subtopics={subtopics} activeSubtopic={null} onSelect={() => {}} />
    );
    const buttons = Array.from(container.querySelectorAll("button[type='button']"))
      .filter((btn) => subtopics.some((s) => btn.textContent?.includes(s.displayName)));
    const names = buttons.map((btn) =>
      subtopics.find((s) => btn.textContent?.includes(s.displayName))?.displayName
    );
    expect(names[0]).toBe("Cardiac Surgery");
    expect(names[1]).toBe("Oncology");
  });

  it("renders 'Less common' divider between items with pubCount > 10 and pubCount <= 10", () => {
    render(<SubtopicRail subtopics={subtopics} activeSubtopic={null} onSelect={() => {}} />);
    expect(screen.getByText("Less common")).toBeTruthy();
  });

  it("applies opacity-60 to subtopics with pubCount <= 10", () => {
    const { container } = render(
      <SubtopicRail subtopics={subtopics} activeSubtopic={null} onSelect={() => {}} />
    );
    const geneTherapyBtn = Array.from(container.querySelectorAll("button[type='button']")).find(
      (btn) => btn.textContent?.includes("Gene Therapy")
    );
    expect(geneTherapyBtn?.className).toContain("opacity-60");
  });

  it("filter input filters items client-side — non-matching items not rendered", () => {
    render(<SubtopicRail subtopics={subtopics} activeSubtopic={null} onSelect={() => {}} />);
    const input = screen.getByPlaceholderText("Filter subareas…");
    fireEvent.change(input, { target: { value: "Cardiac" } });
    expect(screen.getByText("Cardiac Surgery")).toBeTruthy();
    expect(screen.queryByText("Oncology")).toBeNull();
  });

  it("filter clear X button has aria-label='Clear filter'", () => {
    render(<SubtopicRail subtopics={subtopics} activeSubtopic={null} onSelect={() => {}} />);
    const input = screen.getByPlaceholderText("Filter subareas…");
    fireEvent.change(input, { target: { value: "x" } });
    const clearBtn = screen.getByLabelText("Clear filter");
    expect(clearBtn).toBeTruthy();
  });

  it("clicking active subtopic calls onSelect(null) to deselect it", () => {
    const onSelect = vi.fn();
    render(
      <SubtopicRail subtopics={subtopics} activeSubtopic="s1" onSelect={onSelect} />
    );
    const activeBtn = screen.getAllByText("Cardiac Surgery").find((el) => el.tagName !== "SPAN");
    const btn = activeBtn?.closest("button") ?? screen.getByText("Cardiac Surgery").closest("button");
    if (btn) fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("marks the active row with aria-current and the red spine class", () => {
    render(<SubtopicRail subtopics={subtopics} activeSubtopic="s2" onSelect={() => {}} />);
    const btn = screen.getByText("Oncology").closest("button")!;
    expect(btn.getAttribute("aria-current")).toBe("true");
    expect(btn.className).toContain("border-l-[var(--color-primary-cornell-red)]");
    // An active less-common row is never faded.
    const inactive = screen.getByText("Cardiac Surgery").closest("button")!;
    expect(inactive.getAttribute("aria-current")).toBeNull();
    expect(inactive.className).toContain("border-l-transparent");
  });

  it("'All' row shows the total, is current when nothing is selected, and selecting it clears", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <SubtopicRail
        subtopics={subtopics}
        activeSubtopic={null}
        onSelect={onSelect}
        allRow={{ label: "All subareas", count: 297 }}
      />,
    );
    const all = screen.getByText("All subareas").closest("button")!;
    expect(all.getAttribute("aria-current")).toBe("true");
    expect(all.textContent).toContain("297");

    rerender(
      <SubtopicRail
        subtopics={subtopics}
        activeSubtopic="s1"
        onSelect={onSelect}
        allRow={{ label: "All subareas", count: 297 }}
      />,
    );
    const allAgain = screen.getByText("All subareas").closest("button")!;
    expect(allAgain.getAttribute("aria-current")).toBeNull();
    fireEvent.click(allAgain);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("showFilter={false} renders no filter input and lists every item", () => {
    render(
      <TaxonomyRail
        items={subtopics.map((s) => ({ id: s.id, label: s.displayName, count: s.pubCount }))}
        selectedId={null}
        onSelect={vi.fn()}
        railLabel="Related families"
        headerText="RELATED FAMILIES"
        filterPlaceholder="Filter families…"
        showFilter={false}
        filter="zzz"
        noMatchNoun="families"
      />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    for (const s of subtopics) expect(screen.getByText(s.displayName)).toBeTruthy();
  });

  it("formats plain counts with thousands separators (matches the mobile trigger)", () => {
    render(
      <SubtopicRail
        subtopics={subtopics}
        activeSubtopic={null}
        onSelect={vi.fn()}
        allRow={{ label: "All subareas", count: 12345 }}
      />,
    );
    expect(screen.getByText("All subareas").closest("button")!.textContent).toContain(
      (12345).toLocaleString(),
    );
  });

  it("hides the 'All' row while the filter has text", () => {
    render(
      <SubtopicRail
        subtopics={subtopics}
        activeSubtopic={null}
        onSelect={() => {}}
        allRow={{ label: "All subareas", count: 297 }}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Filter subareas…"), {
      target: { value: "onc" },
    });
    expect(screen.queryByText("All subareas")).toBeNull();
  });

  it("clicking an inactive row selects it", () => {
    const onSelect = vi.fn();
    render(<SubtopicRail subtopics={subtopics} activeSubtopic={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Oncology"));
    expect(onSelect).toHaveBeenCalledWith("s2");
  });

  it("does NOT render short_description in the rail (moved to publication-feed h2 subtitle)", () => {
    render(<SubtopicRail subtopics={subtopics} activeSubtopic={null} onSelect={() => {}} />);
    expect(screen.queryByText("Procedures on the heart and great vessels")).toBeNull();
    expect(screen.queryByText("Therapeutic delivery of genetic material")).toBeNull();
  });

  it("renders only the displayName (no second line) regardless of short_description presence", () => {
    const { container } = render(
      <SubtopicRail subtopics={subtopics} activeSubtopic={null} onSelect={() => {}} />
    );
    // Each row should contain a displayName but no truncated description sibling.
    const oncologyButton = Array.from(container.querySelectorAll("button[type='button']"))
      .find((btn) => btn.textContent?.includes("Oncology"));
    expect(oncologyButton).toBeTruthy();
    expect(oncologyButton?.querySelector(".truncate")).toBeFalsy();
  });

  it("filter input matches against the displayName (top-line text), not the underlying label", () => {
    // displayName === label in these fixtures, so filtering on either produces the same result.
    // The test asserts the filter still works after the rail's internal filter callback rename
    // from s.label to s.displayName.
    render(<SubtopicRail subtopics={subtopics} activeSubtopic={null} onSelect={() => {}} />);
    const input = screen.getByPlaceholderText("Filter subareas…");
    fireEvent.change(input, { target: { value: "cardiac" } });
    expect(screen.getByText("Cardiac Surgery")).toBeTruthy();
    expect(screen.queryByText("Oncology")).toBeFalsy();
  });
});
