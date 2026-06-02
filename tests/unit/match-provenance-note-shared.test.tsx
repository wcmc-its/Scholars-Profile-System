/**
 * #707 — the shared "Why this match" note (Scholars + Publications). Quotes each
 * MeSH term because descriptor names are inverted with internal commas
 * ("Carcinoma, Ductal, Breast"); the concept variant reads "tagged …"; the
 * surplus past 3 collapses behind an "and N more" control that expands in place.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, fireEvent } from "@testing-library/react";
import { MatchProvenanceNote } from "@/components/search/match-provenance-note";

const text = (node: React.ReactElement) =>
  renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/“|”/g, '"')
    .replace(/\s+/g, " ")
    .trim();

describe("shared MatchProvenanceNote (#707)", () => {
  it("quotes comma-bearing narrower terms unambiguously", () => {
    const out = text(
      <MatchProvenanceNote
        provenance={{
          kind: "narrower",
          parentTerm: "Breast Neoplasms",
          descendantTerms: ["Carcinoma, Ductal, Breast", "Carcinoma, Lobular"],
        }}
      />,
    );
    expect(out).toContain('"Carcinoma, Ductal, Breast" and "Carcinoma, Lobular"');
    expect(out).toContain('narrower terms of "Breast Neoplasms"');
  });

  it("frames a direct descriptor match as 'tagged \"X\"'", () => {
    const out = text(
      <MatchProvenanceNote provenance={{ kind: "concept", parentTerm: "Breast Neoplasms" }} />,
    );
    expect(out).toContain('tagged "Breast Neoplasms"');
  });

  it("collapses past 3 to an 'and N more' control; hidden terms aren't in the initial render", () => {
    const out = text(
      <MatchProvenanceNote
        provenance={{
          kind: "narrower",
          parentTerm: "Breast Neoplasms",
          descendantTerms: ["A", "B", "C", "Hidden One", "Hidden Two"],
        }}
      />,
    );
    expect(out).toContain("and 2 more");
    expect(out).not.toContain("Hidden One");
  });

  it("click-to-expand reveals the hidden terms in place", () => {
    render(
      <MatchProvenanceNote
        provenance={{
          kind: "narrower",
          parentTerm: "Breast Neoplasms",
          descendantTerms: ["A", "B", "C", "Hidden One", "Hidden Two"],
        }}
      />,
    );
    expect(screen.queryByText(/Hidden One/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /2 more/ }));
    expect(screen.getByText(/Hidden One/)).toBeTruthy();
    expect(screen.getByText(/Hidden Two/)).toBeTruthy();
  });
});
