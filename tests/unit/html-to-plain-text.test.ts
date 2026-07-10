/**
 * `lib/utils.ts` htmlToPlainText — strip-then-decode order.
 *
 * Entities must decode AFTER tag stripping: clinical titles routinely carry
 * escaped comparators ("aged &lt;18 … improvement &gt;10%"), and decoding
 * first turned them into bare < / > that the generic tag-strip regex consumed
 * as one fake tag — deleting the real text between them. Feeds excerpts,
 * search snippets, and every CSV/DOCX export title cell.
 */
import { describe, expect, it } from "vitest";

import { htmlToPlainText } from "@/lib/utils";

describe("htmlToPlainText", () => {
  it("preserves text between escaped comparators (the &lt;18 … &gt;10% bug)", () => {
    const title =
      "Response in patients aged &lt;18 years and improvement &gt;10% at follow-up";
    expect(htmlToPlainText(title, Number.POSITIVE_INFINITY)).toBe(
      "Response in patients aged <18 years and improvement >10% at follow-up",
    );
  });

  it("still strips real inline scientific markup with no replacement", () => {
    expect(htmlToPlainText("Effects of H<sub>2</sub>O on <i>E. coli</i>")).toBe(
      "Effects of H2O on E. coli",
    );
  });

  it("still collapses block tags to a single space", () => {
    expect(htmlToPlainText("<p>First</p><p>Second</p>")).toBe("First Second");
  });

  it("decodes the entity whitelist after stripping", () => {
    expect(htmlToPlainText("A&nbsp;&amp;&nbsp;B &quot;C&#39;s&quot; &sect; end")).toBe(
      "A & B \"C's\" end",
    );
  });

  it("mixed case: escaped comparators survive next to real tags", () => {
    const title = "<b>Dosing</b> at &lt;5 mg vs &gt;20 mg <i>in vivo</i>";
    expect(htmlToPlainText(title)).toBe("Dosing at <5 mg vs >20 mg in vivo");
  });

  it("keeps the excerpt truncation contract", () => {
    const long = "word ".repeat(60).trim();
    const out = htmlToPlainText(long, 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.endsWith("…")).toBe(true);
  });
});
