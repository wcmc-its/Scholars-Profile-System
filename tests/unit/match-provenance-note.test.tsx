/**
 * #702 follow-up — the "Why this match" note must quote each MeSH descendant
 * term. The names are in inverted form with internal commas ("Carcinoma,
 * Ductal, Breast"), so an unquoted comma/"and" join is unreadable. Quoting binds
 * each term unambiguously; "and N more" carries the hidden names in its tooltip.
 *
 * Rendered to static markup (no DOM needed) so we assert the exact text.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchProvenanceNote } from "@/components/search/people-result-card";

// Strip tags so assertions read against the visible text, not the markup.
const text = (node: React.ReactElement) =>
  renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/“|”/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const markup = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("MatchProvenanceNote — narrower (#702 quoting)", () => {
  it("quotes each comma-bearing descendant term so boundaries are unambiguous", () => {
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

  it("a single term reads 'a narrower term of'", () => {
    const out = text(
      <MatchProvenanceNote
        provenance={{ kind: "narrower", parentTerm: "Microbiota", descendantTerms: ["Mycobiome"] }}
      />,
    );
    expect(out).toContain('"Mycobiome" — a narrower term of "Microbiota"');
  });

  it("truncates at 3 with an 'and N more' control whose tooltip lists the hidden terms", () => {
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
    // hidden names live in the title tooltip, not the inline text
    expect(markup(node)).toContain('title="Hidden One; Hidden Two"');
    expect(text(node)).not.toContain("Hidden One —");
  });
});

describe("MatchProvenanceNote — concept (#702)", () => {
  it("frames a direct descriptor match as a tagged concept", () => {
    const out = text(
      <MatchProvenanceNote provenance={{ kind: "concept", parentTerm: "Microbiota" }} />,
    );
    expect(out).toContain('publications tagged "Microbiota"');
  });
});
