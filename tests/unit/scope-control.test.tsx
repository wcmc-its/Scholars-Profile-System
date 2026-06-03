/**
 * Render tests for the enriched MeSH concept hover/focus card (`ScopeNote`).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScopeNote, type ConceptInfo } from "@/components/search/scope-control";

const CRISPR: ConceptInfo = {
  label: "Clustered Regularly Interspaced Short Palindromic Repeats",
  descriptorUi: "D064112",
  definition:
    "Repetitive nucleic acid sequences that are principal components of the archaeal and bacterial CRISPR-CAS SYSTEMS.",
};

describe("ScopeNote — enriched MeSH concept card", () => {
  it("renders the concept identity, matched query, and definition", () => {
    render(<ScopeNote scope="concept" query="crispr" concept={CRISPR} />);
    expect(screen.getByText("MeSH concept")).toBeTruthy();
    expect(screen.getByText("D064112")).toBeTruthy();
    expect(screen.getByText(CRISPR.definition!)).toBeTruthy();
    // The typed query is echoed in the "Matches your search" pill.
    expect(screen.getByText("crispr")).toBeTruthy();
    // The descriptor name appears in both the note sentence and the card header.
    expect(screen.getAllByText(CRISPR.label).length).toBeGreaterThanOrEqual(2);
  });

  it("links 'View record' to the NLM MeSH browser record for the descriptor", () => {
    render(<ScopeNote scope="concept" query="crispr" concept={CRISPR} />);
    const link = screen.getByRole("link", { name: /View record/ });
    expect(link.getAttribute("href")).toBe(
      "https://meshb.nlm.nih.gov/record/ui?ui=D064112",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("omits the definition line when the descriptor has no scope note", () => {
    render(
      <ScopeNote
        scope="concept"
        query="crispr"
        concept={{ ...CRISPR, definition: null }}
      />,
    );
    // Identity + record link still render; only the definition paragraph is gone.
    expect(screen.getByText("D064112")).toBeTruthy();
    expect(screen.getByRole("link", { name: /View record/ })).toBeTruthy();
    expect(screen.queryByText(CRISPR.definition!)).toBeNull();
  });

  it("renders the exact-word note plain — no MeSH card surfaces", () => {
    render(<ScopeNote scope="exact" query="crispr" concept={CRISPR} />);
    expect(screen.getByText(/Matching the exact word/)).toBeTruthy();
    expect(screen.queryByText("MeSH concept")).toBeNull();
    expect(screen.queryByText("D064112")).toBeNull();
  });
});
