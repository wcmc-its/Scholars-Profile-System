import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProvenanceRail, type ProvenanceRailItem } from "@/components/method/provenance-rail";

const ITEM: ProvenanceRailItem = {
  eyebrow: "Verbatim, from a paper using it",
  term: "AAVrh.10 vector",
  sentence: "the liver-tropic AAVrh.10 vector was used to characterize the model",
  source: { href: "/publications/33144353" },
};

describe("ProvenanceRail", () => {
  it("renders the eyebrow, the term, and the sentence with the term marked", () => {
    const { container } = render(<ProvenanceRail item={ITEM} />);
    expect(screen.getByText("Verbatim, from a paper using it")).toBeDefined();
    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("AAVrh.10 vector");
    // the full sentence text survives around the highlight
    expect(container.textContent).toContain(
      "the liver-tropic AAVrh.10 vector was used to characterize the model",
    );
  });

  it("renders a source-publication link to the carried href", () => {
    render(<ProvenanceRail item={ITEM} />);
    const link = screen.getByRole("link", { name: /source publication/i });
    expect(link.getAttribute("href")).toBe("/publications/33144353");
  });

  it("renders the source as a button (not a link) and fires onSelect when supplied (Surface A modal)", () => {
    const onSelect = vi.fn();
    render(
      <ProvenanceRail
        item={{
          ...ITEM,
          source: { label: "View source publication", onSelect },
        }}
      />,
    );
    // onSelect → an in-app <button>, not an anchor.
    expect(screen.queryByRole("link")).toBeNull();
    const btn = screen.getByRole("button", { name: /view source publication/i });
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("prefers onSelect over href when both are present", () => {
    const onSelect = vi.fn();
    render(
      <ProvenanceRail
        item={{ ...ITEM, source: { href: "/publications/33144353", onSelect } }}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: /source publication/i })).toBeDefined();
  });

  it("omits the source control when no source is carried (e.g. a pre-#1158 row)", () => {
    render(<ProvenanceRail item={{ ...ITEM, source: null }} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders no source paragraph for a degenerate source object (neither onSelect nor href)", () => {
    const { container } = render(<ProvenanceRail item={{ ...ITEM, source: { label: "x" } }} />);
    // No control AND no stray empty <p> wrapper for the source row.
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("p.mt-2")).toBeNull();
  });

  it("uses the matched_span offsets when provided (#1166)", () => {
    const sentence = "experiments in MS1 cells and again in MS1 cells";
    const second = sentence.lastIndexOf("MS1 cells");
    const { container } = render(
      <ProvenanceRail
        item={{
          eyebrow: "Verbatim, from a paper using it",
          term: "MS1 cells",
          sentence,
          matchedSpan: { start: second, end: second + "MS1 cells".length },
        }}
      />,
    );
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("MS1 cells");
  });

  it("shows a placeholder (not an empty box) before any term is hovered", () => {
    render(<ProvenanceRail item={null} />);
    expect(screen.getByText(/hover a term to see the verbatim sentence/i)).toBeDefined();
  });

  it("accepts a custom placeholder", () => {
    render(<ProvenanceRail item={null} placeholder="Pick a cell line." />);
    expect(screen.getByText("Pick a cell line.")).toBeDefined();
  });

  it("renders an optional trailing action (e.g. Surface A's view-pubs pill)", () => {
    render(<ProvenanceRail item={ITEM} action={<button>View 11 publications</button>} />);
    expect(screen.getByText("View 11 publications")).toBeDefined();
  });

  it("exposes an aria-live polite region so the sentence is announced on update (§9)", () => {
    const { container } = render(<ProvenanceRail item={ITEM} />);
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});
