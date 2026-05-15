import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PublicationMeta } from "@/components/publication/publication-meta";

// Issue #284 — impact + concept render inline in the meta row.
// Covers the five formatting cases from the issue body.

describe("PublicationMeta — impact / concept inline (issue #284)", () => {
  it("omits the impact block when both scores are undefined", () => {
    const { container } = render(<PublicationMeta citationCount={10} pmid="123" />);
    expect(container.textContent).not.toContain("Impact");
    expect(container.textContent).not.toContain("Concept");
  });

  it("omits the impact block when both scores are null", () => {
    const { container } = render(
      <PublicationMeta
        citationCount={10}
        impactScore={null}
        conceptImpactScore={null}
        pmid="123"
      />,
    );
    expect(container.textContent).not.toContain("Impact");
    expect(container.textContent).not.toContain("Concept");
  });

  it("renders `Impact: N` alone when only impactScore is set", () => {
    const { container } = render(
      <PublicationMeta
        citationCount={10}
        impactScore={42}
        conceptImpactScore={null}
        pmid="123"
      />,
    );
    expect(container.textContent).toMatch(/Impact:\s*42/);
    expect(container.textContent).not.toContain("Concept:");
  });

  it("renders `Concept: N` alone when only conceptImpactScore is set", () => {
    const { container } = render(
      <PublicationMeta
        citationCount={10}
        impactScore={null}
        conceptImpactScore={38}
        pmid="123"
      />,
    );
    expect(container.textContent).toMatch(/Concept:\s*38/);
    expect(container.textContent).not.toMatch(/Impact:\s*\d/);
  });

  it("renders both with a middot separator when both are non-null", () => {
    const { container } = render(
      <PublicationMeta
        citationCount={10}
        impactScore={42}
        conceptImpactScore={38}
        pmid="123"
      />,
    );
    expect(container.textContent).toMatch(/Impact:\s*42.*·.*Concept:\s*38/);
  });

  it("wraps the impact/concept pair in a nowrap span so it doesn't break mid-pair", () => {
    const { container } = render(
      <PublicationMeta
        citationCount={10}
        impactScore={42}
        conceptImpactScore={38}
        pmid="123"
      />,
    );
    const nowrap = container.querySelector(".whitespace-nowrap");
    expect(nowrap).not.toBeNull();
    expect(nowrap!.textContent).toMatch(/Impact:\s*42.*·.*Concept:\s*38/);
  });

  it("rounds non-integer scores to integers (Math.round behavior)", () => {
    const { container } = render(
      <PublicationMeta
        impactScore={41.6}
        conceptImpactScore={37.4}
        pmid="123"
      />,
    );
    expect(container.textContent).toMatch(/Impact:\s*42/);
    expect(container.textContent).toMatch(/Concept:\s*37/);
  });

  it("renders the meta row in the canonical order: PMID · DOI · citations · impact (#316 PR-A reorder)", () => {
    // Pre-#316 order was citations · impact · PMID · ... — identifiers were
    // trailing the LLM-derived numbers. The reorder leads with canonical
    // references (PMID, PMCID, DOI), then role (when present), then the
    // citation count, then impact / concept. This test pins the new order.
    const { container } = render(
      <PublicationMeta
        citationCount={10}
        impactScore={42}
        pmid="123"
        doi="10.0/example"
      />,
    );
    const text = container.textContent ?? "";
    const pmidPos = text.indexOf("PMID:");
    const doiPos = text.indexOf("DOI");
    const citePos = text.indexOf("10 citations");
    const impactPos = text.indexOf("Impact:");
    expect(pmidPos).toBeGreaterThanOrEqual(0);
    expect(doiPos).toBeGreaterThan(pmidPos);
    expect(citePos).toBeGreaterThan(doiPos);
    expect(impactPos).toBeGreaterThan(citePos);
  });

  it("renders the impact block with no surrounding row content when it is the only block", () => {
    const { container } = render(<PublicationMeta impactScore={42} />);
    expect(container.textContent).toMatch(/Impact:\s*42/);
  });

  // Issue #316 PR-C — when `impactJustification` is provided alongside a
  // non-null impactScore, the inline value becomes a hover/focus tooltip
  // trigger. The text content of the row stays the same; the wrapper
  // gets a focusable trigger with `cursor-help`.
  it("wraps Impact: NN in a focusable tooltip trigger when impactJustification is provided (#316 PR-C)", () => {
    const { container } = render(
      <PublicationMeta
        impactScore={42}
        impactJustification="Widely cited mechanistic study with strong methodology."
      />,
    );
    // The value still renders.
    expect(container.textContent).toMatch(/Impact:\s*42/);
    // A focusable span is now wrapping it (tabIndex=0 means tabindex attr present).
    const focusable = container.querySelector('[tabindex="0"]');
    expect(focusable).not.toBeNull();
    expect(focusable!.textContent).toMatch(/Impact:\s*42/);
  });

  it("does NOT wrap Impact in a tooltip when impactJustification is null or empty (no signal worth surfacing)", () => {
    const { container: bareContainer } = render(<PublicationMeta impactScore={42} />);
    expect(bareContainer.querySelector('[tabindex="0"]')).toBeNull();

    const { container: nullContainer } = render(
      <PublicationMeta impactScore={42} impactJustification={null} />,
    );
    expect(nullContainer.querySelector('[tabindex="0"]')).toBeNull();

    const { container: emptyContainer } = render(
      <PublicationMeta impactScore={42} impactJustification="" />,
    );
    expect(emptyContainer.querySelector('[tabindex="0"]')).toBeNull();
  });

  it("does NOT wrap when impactScore is null even if a justification string is provided (nothing to explain)", () => {
    const { container } = render(
      <PublicationMeta
        impactScore={null}
        impactJustification="Some text that wouldn't have a referent"
      />,
    );
    // No impact value rendered, so no tooltip trigger.
    expect(container.textContent).not.toContain("Impact:");
    expect(container.querySelector('[tabindex="0"]')).toBeNull();
  });
});
