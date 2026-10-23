/**
 * SEARCH_PUB_HIGHLIGHT — `highlightedTitleHtml` styles the OpenSearch <mark>
 * fragment for a publication title: keep the scientific-notation whitelist
 * (i/em/b/strong/sup/sub) plus <mark>, drop everything else, merge contiguous
 * marks into one pill, keep only the first occurrence of a term, and apply a
 * quiet pale-brand tint (rgba(179,27,27,.10)) behind the span — never the
 * post-it-yellow <mark> default (#20).
 */
import { describe, expect, it } from "vitest";
import { highlightedTitleHtml, MARK_CLASS } from "@/lib/search/highlight-title";

// Sourced from the module rather than re-typed: a hand-copied literal here silently
// pinned the pill's old class list and turned an intended style change into 6 failures.
const mark = (inner: string) => `<mark class="${MARK_CLASS}">${inner}</mark>`;

describe("highlightedTitleHtml", () => {
  it("#1909 — the pill's padding is cancelled by an equal negative margin (no added advance)", () => {
    // Without this the 3px right padding pushes a trailing period off the word and the
    // title renders "Acute Myeloid Leukemia ." on every highlighted key paper.
    const pad = MARK_CLASS.match(/(?:^|\s)px-\[(\d+)px\]/)?.[1];
    const pull = MARK_CLASS.match(/(?:^|\s)-mx-\[(\d+)px\]/)?.[1];
    expect(pad).toBeDefined();
    expect(pull).toBe(pad);
  });

  it("applies the pale-tint pill and resets the yellow background", () => {
    expect(highlightedTitleHtml("The Traveling <mark>Microbiome</mark>.")).toBe(
      `The Traveling ${mark("Microbiome")}.`,
    );
  });

  it("preserves scientific-notation tags around a mark", () => {
    expect(highlightedTitleHtml("H<sub>2</sub>O and <mark>microbiome</mark>")).toBe(
      `H<sub>2</sub>O and ${mark("microbiome")}`,
    );
  });

  it("strips non-whitelisted tags (e.g. a stray script/span) but keeps marks", () => {
    expect(
      highlightedTitleHtml('<span onclick="x">A</span> <script>bad()</script> <mark>B</mark>'),
    ).toBe(`A bad() ${mark("B")}`);
  });

  it("drops mark attributes from the source, applying only our class", () => {
    expect(highlightedTitleHtml('<mark data-x="1">x</mark>')).toBe(mark("x"));
  });

  it("first-occurrence only: a repeated marked term doesn't strobe", () => {
    expect(
      highlightedTitleHtml(
        "Maternal gut <mark>microbiome</mark> regulates neonatal gut <mark>microbiome</mark>.",
      ),
    ).toBe(`Maternal gut ${mark("microbiome")} regulates neonatal gut microbiome.`);
  });

  it("merges contiguous marks into one pill (the phrase case)", () => {
    expect(highlightedTitleHtml("<mark>Microbiome</mark> <mark>Research</mark> in X")).toBe(
      `${mark("Microbiome Research")} in X`,
    );
  });
});

describe("highlightedTitleHtml — tag-splicing bypass", () => {
  // One-pass stripping splices the text around a removed tag into a new tag:
  // `<<x>script>` loses `<x>` and leaves `<script>`.
  const PAYLOAD =
    "Gene <mark>X</mark><<x>script>alert(document.domain)<<x>/script> " +
    "<<x>a href=javascript:alert(1)>see <<x>img src=x onerror=alert(1)>";

  function render(html: string): HTMLDivElement {
    const el = document.createElement("div");
    el.innerHTML = html;
    return el;
  }

  it("escapes spliced tags and keeps the legitimate mark", () => {
    const out = highlightedTitleHtml(PAYLOAD);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<a /i);
    expect(out).not.toMatch(/<img/i);
    expect(out).toContain("&lt;");
    expect(out.startsWith(`Gene ${mark("X")}`)).toBe(true);
    const el = render(out);
    expect(el.querySelectorAll("script, a, img")).toHaveLength(0);
    expect(el.querySelectorAll("mark")).toHaveLength(1);
  });

  it("escapes a spliced mark that would carry an event handler", () => {
    const out = highlightedTitleHtml("<<x>mark onmouseover=alert(1)>x</mark>");
    expect(out).toBe("&lt;mark onmouseover=alert(1)>x</mark>");
    expect(render(out).querySelectorAll("[onmouseover]")).toHaveLength(0);
  });

  it("leaves legitimate content as it was", () => {
    expect(highlightedTitleHtml("<mark>p</mark> < 0.05")).toBe(`${mark("p")} &lt; 0.05`);
    expect(highlightedTitleHtml('<i class="x">in vivo</i> H<sub>2</sub>O')).toBe(
      "<i>in vivo</i> H<sub>2</sub>O",
    );
    expect(highlightedTitleHtml('<mark data-x="1">Gut</mark> <MARK>Microbiome</MARK>')).toBe(
      mark("Gut Microbiome"),
    );
  });
});
