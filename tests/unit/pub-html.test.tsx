/**
 * `components/publication/pub-html.tsx` — the single sanctioned render path for
 * PubMed publication strings (#946). These tests pin the behavior the guardrail
 * relies on: whitelist markup survives, everything else is stripped, and
 * null/empty renders nothing.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { PubHtml, PubTitle, PubJournal, PubAbstract } from "@/components/publication/pub-html";

describe("PubHtml primitive", () => {
  it("renders the chosen element tag", () => {
    const { container } = render(<PubHtml as="p" value="Hello" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("P");
    expect(el.textContent).toBe("Hello");
  });

  it("honors whitelisted PubMed inline markup (<i>, <sub>, <sup>, <b>)", () => {
    const { container } = render(
      <PubHtml as="span" value="<i>BRCA1</i> in H<sub>2</sub>O at CO<sup>2</sup> <b>x</b>" />,
    );
    const html = (container.firstElementChild as HTMLElement).innerHTML;
    expect(html).toContain("<i>BRCA1</i>");
    expect(html).toContain("H<sub>2</sub>O");
    expect(html).toContain("CO<sup>2</sup>");
    expect(html).toContain("<b>x</b>");
  });

  it("strips disallowed tags entirely (<script>)", () => {
    const { container } = render(
      <PubHtml as="span" value={'safe<script>alert("xss")</script>tail'} />,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.querySelector("script")).toBeNull();
    expect(el.innerHTML).not.toContain("<script");
    // The sanitizer removes the tags but leaves their text content.
    expect(el.textContent).toBe('safealert("xss")tail');
  });

  it("strips event-handler attributes and other attributes off whitelisted tags", () => {
    const { container } = render(
      <PubHtml as="span" value={'<i onclick="steal()" class="evil">gene</i>'} />,
    );
    const el = container.firstElementChild as HTMLElement;
    const i = el.querySelector("i") as HTMLElement;
    expect(i).not.toBeNull();
    expect(i.getAttribute("onclick")).toBeNull();
    expect(i.getAttribute("class")).toBeNull();
    expect(el.innerHTML).toBe("<i>gene</i>");
  });

  it("renders nothing for null / undefined / empty", () => {
    expect(render(<PubHtml as="span" value={null} />).container.firstElementChild).toBeNull();
    expect(render(<PubHtml as="span" value={undefined} />).container.firstElementChild).toBeNull();
    expect(render(<PubHtml as="span" value="" />).container.firstElementChild).toBeNull();
  });

  it("passes className and title through", () => {
    const { container } = render(
      <PubHtml as="span" value="t" className="font-medium line-through" title="full title" />,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toBe("font-medium line-through");
    expect(el.getAttribute("title")).toBe("full title");
  });
});

describe("semantic wrappers", () => {
  it("PubTitle defaults to <span> and overrides to any tag", () => {
    expect(
      (render(<PubTitle value="t" />).container.firstElementChild as HTMLElement).tagName,
    ).toBe("SPAN");
    expect(
      (render(<PubTitle as="p" value="t" />).container.firstElementChild as HTMLElement).tagName,
    ).toBe("P");
  });

  it("PubJournal defaults to <em>", () => {
    expect(
      (render(<PubJournal value="J" />).container.firstElementChild as HTMLElement).tagName,
    ).toBe("EM");
  });

  it("PubAbstract defaults to <div> and sanitizes the same way", () => {
    const { container } = render(
      <PubAbstract value={"<i>ok</i><script>bad</script>"} className="prose" />,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("DIV");
    expect(el.querySelector("i")).not.toBeNull();
    expect(el.querySelector("script")).toBeNull();
  });

  it("all wrappers render nothing for empty values", () => {
    expect(render(<PubTitle value={null} />).container.firstElementChild).toBeNull();
    expect(render(<PubJournal value="" />).container.firstElementChild).toBeNull();
    expect(render(<PubAbstract value={undefined} />).container.firstElementChild).toBeNull();
  });
});
