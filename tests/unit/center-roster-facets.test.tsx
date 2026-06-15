/**
 * #972 — searchable Methods & tools facet. `RosterFacet` gains an opt-in
 * `searchable` typeahead (off by default so Program / Membership / Org unit are
 * unchanged). Covered:
 *  - input only renders when `searchable` AND options exceed `collapseAfter`.
 *  - typing filters by case-insensitive label substring and bypasses the cap.
 *  - a SELECTED option stays visible + de-selectable even when it no longer
 *    matches the query (pinned first, never listed twice).
 *  - clearing the query restores the collapse-after behavior.
 *  - empty-result line shows only when searching with no match and no selection.
 *  - counts are parent-supplied display values, untouched by the query.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RosterFacet, type FacetOption } from "@/components/center/center-roster-facets";

// 10 options so options.length (10) > collapseAfter (8) → search input appears
// and the collapse cap is active.
const OPTS: FacetOption[] = [
  "Deep learning",
  "MRI",
  "Sequencing",
  "CRISPR",
  "Mass spectrometry",
  "Flow cytometry",
  "Microscopy",
  "PCR",
  "Western blot",
  "ELISA",
].map((label, i) => ({ value: `v${i}::${label}`, label, count: 10 - i }));

const noop = () => {};
const empty: ReadonlySet<string> = new Set();

// Option buttons only; drop the "Show all/fewer" control.
function optionLabels() {
  return screen
    .getAllByRole("button")
    .map((b) => b.textContent ?? "")
    .filter((t) => !/^Show /.test(t));
}

describe("RosterFacet — searchable Methods facet (#972)", () => {
  it("renders NO search input when searchable is unset (other facets unchanged)", () => {
    render(
      <RosterFacet
        title="Organizational unit"
        options={OPTS}
        selected={empty}
        onToggle={noop}
        collapseAfter={8}
      />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders a search input when searchable AND options exceed collapseAfter", () => {
    render(
      <RosterFacet
        title="Methods & tools"
        options={OPTS}
        selected={empty}
        onToggle={noop}
        collapseAfter={8}
        searchable
        searchPlaceholder="Search methods…"
      />,
    );
    expect(screen.getByRole("textbox", { name: /Search Methods/ })).toBeTruthy();
  });

  it("renders NO search input when searchable but options do not exceed collapseAfter", () => {
    render(
      <RosterFacet
        title="Methods & tools"
        options={OPTS.slice(0, 8)}
        selected={empty}
        onToggle={noop}
        collapseAfter={8}
        searchable
      />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("typing filters options by case-insensitive label substring and bypasses the cap", () => {
    render(
      <RosterFacet
        title="Methods & tools"
        options={OPTS}
        selected={empty}
        onToggle={noop}
        collapseAfter={8}
        searchable
      />,
    );
    // Before searching: only first 8 show (collapsed) — ELISA (10th) is hidden.
    expect(screen.queryByRole("button", { name: /ELISA/ })).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "elisa" } });
    // Case-insensitive match, surfaced past the collapse cap.
    expect(screen.getByRole("button", { name: /ELISA/ })).toBeTruthy();
    expect(optionLabels()).toEqual(["ELISA1"]); // only the match; count rendered inline
  });

  it("keeps a SELECTED option visible + de-selectable even when it does NOT match the query", () => {
    let toggled: string | null = null;
    const selected: ReadonlySet<string> = new Set(["v1::MRI"]); // MRI selected
    render(
      <RosterFacet
        title="Methods & tools"
        options={OPTS}
        selected={selected}
        onToggle={(v) => {
          toggled = v;
        }}
        collapseAfter={8}
        searchable
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "crispr" } });
    // MRI does not match "crispr" but is pinned because selected; CRISPR also shows.
    const mri = screen.getByRole("button", { name: /^MRI/ });
    expect(mri.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /CRISPR/ })).toBeTruthy();
    // Still de-selectable: clicking the pinned, non-matching option toggles it.
    fireEvent.click(mri);
    expect(toggled).toBe("v1::MRI");
  });

  it("pins selected first and does NOT list a selected match twice", () => {
    const selected: ReadonlySet<string> = new Set(["v3::CRISPR"]);
    render(
      <RosterFacet
        title="Methods & tools"
        options={OPTS}
        selected={selected}
        onToggle={noop}
        collapseAfter={8}
        searchable
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "cr" } }); // matches CRISPR (selected)
    expect(screen.getAllByRole("button", { name: /CRISPR/ })).toHaveLength(1); // de-duped
  });

  it("clearing the query restores the collapse-after behavior", () => {
    render(
      <RosterFacet
        title="Methods & tools"
        options={OPTS}
        selected={empty}
        onToggle={noop}
        collapseAfter={8}
        searchable
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "elisa" } });
    expect(screen.getByRole("button", { name: /ELISA/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } }); // clear
    // Back to collapsed: 8 visible, ELISA hidden again, "Show all 10" returns.
    expect(screen.queryByRole("button", { name: /ELISA/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Show all 10/ })).toBeTruthy();
  });

  it("shows the empty-result line (custom noMatchLabel) when nothing matches and nothing is selected", () => {
    render(
      <RosterFacet
        title="Methods & tools"
        options={OPTS}
        selected={empty}
        onToggle={noop}
        collapseAfter={8}
        searchable
        noMatchLabel="No methods match"
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzzzz" } });
    expect(screen.getByText("No methods match")).toBeTruthy();
  });

  it("empty-result line falls back to a generic default when noMatchLabel is omitted", () => {
    render(
      <RosterFacet
        title="Subjects"
        options={OPTS}
        selected={empty}
        onToggle={noop}
        collapseAfter={8}
        searchable
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzzzz" } });
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("display-only: a non-matching selected option keeps its parent-supplied count (no recompute)", () => {
    const selected: ReadonlySet<string> = new Set(["v1::MRI"]); // count 9
    render(
      <RosterFacet
        title="Methods & tools"
        options={OPTS}
        selected={selected}
        onToggle={noop}
        collapseAfter={8}
        searchable
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzzzz" } });
    // Only the pinned selected option shows, still carrying its original count 9.
    // The accessible name joins the label + count spans with a space.
    expect(screen.getByRole("button", { name: /^MRI 9$/ })).toBeTruthy();
    expect(screen.queryByText("No methods match")).toBeNull(); // suppressed: a selection is visible
  });
});
