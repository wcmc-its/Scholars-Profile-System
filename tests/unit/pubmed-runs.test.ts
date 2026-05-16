/**
 * Word `TextRun` builder for PubMed-style strings (#331).
 *
 * Inspects the `docx` `TextRun` internals (`r.properties.root` carries
 * `BuilderElement` nodes for italics, bold, sub/superscript). The shape
 * is private to docx so the helpers below shield the assertions from
 * any future internal refactor.
 *
 * Asserts the issue's PMID 29326275 fixture: `CX3CR1<sup>+</sup>`
 * builds three runs where the middle `+` has `superScript: true`.
 */
import { describe, expect, it } from "vitest";
import { TextRun } from "docx";
import { buildPubmedRuns } from "@/lib/pubmed-runs";

type RawNode = { rootKey: string; root?: unknown };

function runText(r: TextRun): string {
  // r.root[1] is the `w:t` element; its `root` array ends in the literal
  // text string. Earlier entries are `_attr` metadata.
  const tNode = (r as unknown as { root: RawNode[] }).root[1] as RawNode & {
    root: unknown[];
  };
  const literal = tNode.root.find((x) => typeof x === "string");
  return typeof literal === "string" ? literal : "";
}

function runProps(r: TextRun): RawNode[] {
  return (r as unknown as { properties: { root: RawNode[] } }).properties.root;
}

function runVertAlign(r: TextRun): "superscript" | "subscript" | null {
  const v = runProps(r).find((p) => p.rootKey === "w:vertAlign");
  if (!v) return null;
  const attr = (v.root as RawNode[])[0] as
    | { root?: { val?: { value?: string } } }
    | undefined;
  const val = attr?.root?.val?.value;
  if (val === "superscript" || val === "subscript") return val;
  return null;
}

function runHasItalic(r: TextRun): boolean {
  return runProps(r).some((p) => p.rootKey === "w:i");
}

function runHasBold(r: TextRun): boolean {
  return runProps(r).some((p) => p.rootKey === "w:b");
}

describe("buildPubmedRuns — sup/sub/italic/bold (#331)", () => {
  it("plain text emits one run with no formatting", () => {
    const runs = buildPubmedRuns("Hello world");
    expect(runs).toHaveLength(1);
    expect(runText(runs[0]!)).toBe("Hello world");
    expect(runVertAlign(runs[0]!)).toBeNull();
    expect(runHasItalic(runs[0]!)).toBe(false);
    expect(runHasBold(runs[0]!)).toBe(false);
  });

  it("PMID 29326275 fixture — `CX3CR1<sup>+</sup>` emits a `+` run with superScript: true", () => {
    const runs = buildPubmedRuns("CX3CR1<sup>+</sup> mononuclear");
    // Three runs: "CX3CR1", "+", " mononuclear"
    expect(runs).toHaveLength(3);
    expect(runText(runs[0]!)).toBe("CX3CR1");
    expect(runVertAlign(runs[0]!)).toBeNull();

    expect(runText(runs[1]!)).toBe("+");
    expect(runVertAlign(runs[1]!)).toBe("superscript");

    expect(runText(runs[2]!)).toBe(" mononuclear");
    expect(runVertAlign(runs[2]!)).toBeNull();
  });

  it("`<sub>` emits subScript", () => {
    const runs = buildPubmedRuns("H<sub>2</sub>O");
    expect(runText(runs[1]!)).toBe("2");
    expect(runVertAlign(runs[1]!)).toBe("subscript");
  });

  it("`<i>` and `<em>` both emit italics", () => {
    for (const tag of ["i", "em"] as const) {
      const runs = buildPubmedRuns(`pre<${tag}>mid</${tag}>post`);
      expect(runText(runs[1]!)).toBe("mid");
      expect(runHasItalic(runs[1]!)).toBe(true);
    }
  });

  it("`<b>` and `<strong>` are dropped by default (Vancouver titles)", () => {
    for (const tag of ["b", "strong"] as const) {
      const runs = buildPubmedRuns(`pre<${tag}>mid</${tag}>post`);
      expect(runText(runs[1]!)).toBe("mid");
      expect(runHasBold(runs[1]!)).toBe(false);
    }
  });

  it("`allowBold` opts in to bold runs (abstract callers)", () => {
    const runs = buildPubmedRuns("pre<b>mid</b>post", { allowBold: true });
    expect(runText(runs[1]!)).toBe("mid");
    expect(runHasBold(runs[1]!)).toBe(true);
    // <strong> behaves the same as <b>.
    const r2 = buildPubmedRuns("a<strong>B</strong>c", { allowBold: true });
    expect(runText(r2[1]!)).toBe("B");
    expect(runHasBold(r2[1]!)).toBe(true);
  });

  it("normalizes smart quotes and en/em dashes by default", () => {
    const runs = buildPubmedRuns("“smart” – dash — em");
    expect(runText(runs[0]!)).toBe('"smart" - dash -- em');
  });

  it("handles unbalanced and unknown tags without throwing", () => {
    expect(() => buildPubmedRuns("foo<sup>bar")).not.toThrow();
    expect(() => buildPubmedRuns("</sup>foo")).not.toThrow();
    // <u> is silently dropped per legacy behavior.
    const runs = buildPubmedRuns("a<u>b</u>c");
    const text = runs.map(runText).join("");
    expect(text).toBe("abc");
  });
});
