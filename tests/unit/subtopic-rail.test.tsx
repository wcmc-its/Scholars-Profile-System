import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SubtopicRail } from "@/components/topic/subtopic-rail";

const subtopics = [
  { id: "s1", label: "Cardiac Surgery", pubCount: 234 },
  { id: "s2", label: "Oncology", pubCount: 50 },
  { id: "s3", label: "Gene Therapy", pubCount: 10 },
  { id: "s4", label: "Case Reports", pubCount: 3 },
];

describe("SubtopicRail", () => {
  it("renders all subtopic labels", () => {
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
      .filter((btn) => subtopics.some((s) => btn.textContent?.includes(s.label)));
    const labels = buttons.map((btn) =>
      subtopics.find((s) => btn.textContent?.includes(s.label))?.label
    );
    expect(labels[0]).toBe("Cardiac Surgery");
    expect(labels[1]).toBe("Oncology");
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
    const input = screen.getByPlaceholderText("Filter subtopics…");
    fireEvent.change(input, { target: { value: "Cardiac" } });
    expect(screen.getByText("Cardiac Surgery")).toBeTruthy();
    expect(screen.queryByText("Oncology")).toBeNull();
  });

  it("filter clear X button has aria-label='Clear filter'", () => {
    render(<SubtopicRail subtopics={subtopics} activeSubtopic={null} onSelect={() => {}} />);
    const input = screen.getByPlaceholderText("Filter subtopics…");
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

  it("component exports (RED: implementation pending Plan 07)", () => {
    expect(typeof SubtopicRail).toBe("function");
  });
});
