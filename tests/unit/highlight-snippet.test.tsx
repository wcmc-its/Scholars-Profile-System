import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { highlightSnippet, snippetEllipsis } from "@/components/method/highlight-snippet";

function renderNode(node: React.ReactNode) {
  return render(<div data-testid="wrap">{node}</div>);
}

describe("highlightSnippet — interim term matching (#1119)", () => {
  it("marks a verbatim term occurrence, preserving the sentence's casing", () => {
    const { container } = renderNode(
      highlightSnippet("A corneal confocal microscope was used here.", "corneal confocal microscope"),
    );
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("corneal confocal microscope");
    // full sentence text is preserved around the mark
    expect(container.querySelector('[data-testid="wrap"]')?.textContent).toBe(
      "A corneal confocal microscope was used here.",
    );
  });

  it("matches case-insensitively but keeps the snippet's own casing in the mark", () => {
    const { container } = renderNode(highlightSnippet("We used chexpert to label findings.", "CheXpert"));
    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("chexpert");
  });

  it("returns the plain sentence (no mark) when the term does not occur", () => {
    const { container } = renderNode(
      highlightSnippet("Nothing relevant in this sentence.", "scRNA-seq"),
    );
    expect(container.querySelectorAll("mark")).toHaveLength(0);
    expect(container.textContent).toBe("Nothing relevant in this sentence.");
  });

  it("returns the plain sentence when the term is empty and no span is given", () => {
    const { container } = renderNode(highlightSnippet("Some sentence.", "   "));
    expect(container.querySelectorAll("mark")).toHaveLength(0);
    expect(container.textContent).toBe("Some sentence.");
  });
});

describe("highlightSnippet — offset-driven (#1166 matched_span)", () => {
  it("uses the char-offset span, ignoring term matching entirely", () => {
    // term does not appear verbatim → only the span proves which slice was marked.
    // A complete sentence keeps the fragment-ellipsis fallback out of the way.
    const { container } = renderNode(highlightSnippet("Abcdefgh.", "zzz", { start: 2, end: 5 }));
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("cde");
    expect(container.textContent).toBe("Abcdefgh.");
  });

  it("targets the exact occurrence the span points at, not a naive first match", () => {
    // "MS1" appears twice; the span points at the SECOND occurrence.
    const sentence = "the MS1 line and the MS1 derivative";
    const second = sentence.lastIndexOf("MS1");
    const { container } = renderNode(
      highlightSnippet(sentence, "MS1", { start: second, end: second + 3 }),
    );
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("MS1");
    // the text BEFORE the mark includes the first, unmarked "MS1"
    expect(marks[0].previousSibling?.textContent).toContain("the MS1 line and the ");
  });

  it("falls back to term matching when the span is out of bounds", () => {
    const { container } = renderNode(
      highlightSnippet("use MS1 cells here", "MS1", { start: 0, end: 999 }),
    );
    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("MS1");
  });
});

describe("highlightSnippet — fragment-boundary ellipsis (display fallback, ReciterAI #254)", () => {
  it("flags a leading ellipsis when the snippet starts mid-sentence (lowercase)", () => {
    expect(snippetEllipsis("they both dimerize in HEK293 cells")).toEqual({ lead: "…", trail: "…" });
  });

  it("adds no ellipsis to a complete sentence", () => {
    expect(snippetEllipsis("HEK293 cells were transfected.")).toEqual({ lead: "", trail: "" });
  });

  it("adds a trailing ellipsis only when the end lacks terminal punctuation", () => {
    expect(snippetEllipsis("They used HEK293 cells")).toEqual({ lead: "", trail: "…" });
    expect(snippetEllipsis("Why HEK293 cells?")).toEqual({ lead: "", trail: "" });
    expect(snippetEllipsis('It "worked."')).toEqual({ lead: "", trail: "" });
  });

  it("wraps a mid-sentence fragment with leading and trailing ellipses", () => {
    const { container } = renderNode(highlightSnippet("they used HEK293 cells", "HEK293 cells"));
    expect(container.textContent).toBe("…they used HEK293 cells…");
    expect(container.querySelector("mark")?.textContent).toBe("HEK293 cells");
  });

  it("shifts the matched span so a leading ellipsis never mis-slices the mark", () => {
    const sentence = "they used HEK293 cells"; // lowercase start → leading "…"
    const start = sentence.indexOf("HEK293 cells");
    const { container } = renderNode(
      highlightSnippet(sentence, "zzz", { start, end: start + "HEK293 cells".length }),
    );
    expect(container.querySelector("mark")?.textContent).toBe("HEK293 cells");
    expect(container.textContent).toBe("…they used HEK293 cells…");
  });
});
