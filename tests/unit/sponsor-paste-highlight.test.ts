/**
 * `lib/sponsor-paste-highlight.ts` — marking the paste with the extracted concepts.
 *
 * The interesting cases are all failure modes of naive substring marking: a needle nested in a
 * longer one, a needle inside an unrelated word, the same needle twice, and — the one that is
 * NOT a bug — a canonicalised concept that never appears in the paste at all.
 */
import { describe, expect, it } from "vitest";

import type { SponsorConcept } from "@/lib/api/sponsor-match-contract";
import { markPaste, markedConceptCount } from "@/lib/sponsor-paste-highlight";

function concept(term: string, members: string[] = []): SponsorConcept {
  return { term, kind: "concept", members, centrality: 0.5, weightFactor: 1 };
}

/** The marked text, and the concept each mark points at. */
function marks(segments: ReturnType<typeof markPaste>) {
  return segments.filter((s) => s.term).map((s) => [s.text, s.term]);
}

describe("markPaste", () => {
  it("marks a member and preserves the paste's own casing", () => {
    const segs = markPaste("We fund Cystic Fibrosis work.", [concept("cystic fibrosis")]);
    expect(marks(segs)).toEqual([["Cystic Fibrosis", "cystic fibrosis"]]);
    expect(segs.map((s) => s.text).join("")).toBe("We fund Cystic Fibrosis work.");
  });

  it("prefers the longer, more specific concept over one nested inside it", () => {
    const segs = markPaste("interested in cardiac fibrosis", [
      concept("fibrosis"),
      concept("cardiac fibrosis"),
    ]);
    // NOT two marks, and not the generic "fibrosis" — the specific concept claims the span.
    expect(marks(segs)).toEqual([["cardiac fibrosis", "cardiac fibrosis"]]);
  });

  it("does not match inside a longer word", () => {
    // The whole point of the word-boundary check: CF must not light up inside CFTR.
    const segs = markPaste("the CFTR gene", [concept("CF")]);
    expect(marks(segs)).toEqual([]);
  });

  it("marks every occurrence of a repeated term", () => {
    const segs = markPaste("asthma now, asthma later", [concept("asthma")]);
    expect(marks(segs)).toEqual([
      ["asthma", "asthma"],
      ["asthma", "asthma"],
    ]);
  });

  it("maps a member phrasing back to its representative concept term", () => {
    const segs = markPaste("our CAR-T program", [
      concept("chimeric antigen receptor T-cell therapy", ["CAR-T"]),
    ]);
    expect(marks(segs)).toEqual([["CAR-T", "chimeric antigen receptor T-cell therapy"]]);
  });

  it("leaves a canonicalised concept unmarked rather than guessing — the documented ceiling", () => {
    // The extractor expands "CF" to "cystic fibrosis"; that string is nowhere in the paste, so
    // there is nothing honest to mark. This must degrade to plain text, not throw or mis-anchor.
    const segs = markPaste("we care about CF", [concept("cystic fibrosis")]);
    expect(marks(segs)).toEqual([]);
    expect(segs).toEqual([{ text: "we care about CF" }]);
    expect(markedConceptCount(segs)).toBe(0);
  });

  it("counts distinct concepts marked, not marks", () => {
    const segs = markPaste("asthma and asthma and COPD", [concept("asthma"), concept("COPD")]);
    expect(markedConceptCount(segs)).toBe(2);
  });

  it("returns the paste intact when there are no concepts", () => {
    expect(markPaste("some text", [])).toEqual([{ text: "some text" }]);
  });
});
