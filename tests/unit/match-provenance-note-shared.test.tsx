/**
 * #707 — the shared "Why this match" note (Scholars + Publications). Quotes each
 * MeSH term because descriptor names are inverted with internal commas
 * ("Carcinoma, Ductal, Breast"); the concept variant reads "tagged …".
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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

  it("truncates at 3 with 'and N more' and a tooltip of the hidden terms", () => {
    const node = (
      <MatchProvenanceNote
        provenance={{
          kind: "narrower",
          parentTerm: "Breast Neoplasms",
          descendantTerms: ["A", "B", "C", "Hidden One", "Hidden Two"],
        }}
      />
    );
    expect(text(node)).toContain("and 2 more");
    expect(renderToStaticMarkup(node)).toContain('title="Hidden One; Hidden Two"');
  });
});
