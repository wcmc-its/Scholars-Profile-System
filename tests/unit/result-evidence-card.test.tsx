/**
 * #824 follow-up Phase 1 — the single `<ResultEvidence>` renderer. One golden
 * render per kind, plus the E2 areas treatment and the DOM-level guardrails
 * (no raw slug leaks; bounded list).
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ResultEvidence } from "@/components/search/result-evidence";
import { RepresentativePapers } from "@/components/search/match-reason";
import type { ResultEvidence as Evidence } from "@/lib/api/result-evidence";

const renderEv = (evidence: Evidence) => render(<ResultEvidence evidence={evidence} />);

describe("<ResultEvidence> — one render per kind", () => {
  it("method ⇒ Method badge + bold family, with NO exemplar-tool trail", () => {
    renderEv({ kind: "method", family: "Single-cell RNA sequencing", tools: ["scRNA-seq", "10x"] });
    expect(screen.getByText("Method")).toBeTruthy();
    expect(screen.getByText("Single-cell RNA sequencing").tagName).toBe("STRONG");
    // The related-terms trail was dropped — the family name stands alone even when
    // the evidence object still carries tools (kept so it can be reinstated later).
    expect(screen.queryByText("scRNA-seq")).toBeNull();
    expect(screen.queryByText("10x")).toBeNull();
  });

  it("topic ⇒ Research area badge + bold label", () => {
    renderEv({ kind: "topic", label: "Single-cell & spatial biology", id: "single_cell_spatial_biology" });
    expect(screen.getByText("Research area")).toBeTruthy();
    expect(screen.getByText("Single-cell & spatial biology").tagName).toBe("STRONG");
  });

  it("shows a real disclosure chevron BUTTON on method AND topic badges when canExpand", () => {
    // The chevron is now a real clickable `<button>` (replaces the hover ▾); it
    // must appear for both kinds, and only when canExpand + onToggle are given.
    const noop = () => {};
    const { container: m } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Flow cytometry", tools: [] }}
        canExpand
        onToggle={noop}
      />,
    );
    const mBtn = m.querySelector("button");
    expect(mBtn).toBeTruthy();
    expect(mBtn?.getAttribute("aria-expanded")).toBe("false");
    // Item 1 — the whole cluster is the button: its accessible name carries the
    // matched label PLUS the sr-only "representative papers" affordance.
    expect(mBtn?.textContent).toMatch(/Flow cytometry/);
    expect(mBtn?.textContent).toMatch(/representative papers/i);

    const { container: t } = render(
      <ResultEvidence
        evidence={{ kind: "topic", label: "Immunology", id: "immunology" }}
        canExpand
        onToggle={noop}
      />,
    );
    expect(t.querySelector("button")).toBeTruthy();

    // Off ⇒ no chevron button.
    const { container: off } = render(
      <ResultEvidence evidence={{ kind: "topic", label: "Immunology", id: "immunology" }} />,
    );
    expect(off.querySelector("button")).toBeNull();
  });

  it("the chevron button reflects `expanded` (rotated) and calls onToggle on click", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Flow cytometry", tools: [] }}
        canExpand
        expanded
        onToggle={onToggle}
      />,
    );
    const btn = container.querySelector("button")!;
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[class*="rotate-180"]')).toBeTruthy();
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("publications:tagged ⇒ count line; chevron present only when pubs exist (canExpand)", () => {
    const onToggle = () => {};
    // No pubs ⇒ no chevron offered (the card passes canExpand=false).
    renderEv({ kind: "publications", strength: "tagged", text: "25 of 373 publications tagged Melanoma", count: 25 });
    expect(screen.getByText(/25 of 373 publications tagged Melanoma/)).toBeTruthy();

    // With pubs the card threads canExpand=true ⇒ a chevron button trails the line.
    const { container } = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "tagged",
          text: "25 of 373 publications tagged Melanoma",
          count: 25,
          pubs: [{ pmid: "1", title: "T", year: 2020 }],
        }}
        canExpand
        onToggle={onToggle}
      />,
    );
    const btn = container.querySelector("button")!;
    expect(btn).toBeTruthy();
    // Item 1 — the count line lives INSIDE the toggle (content-width cluster), so
    // clicking the count — not just a marooned chevron — opens the panel.
    expect(btn.textContent).toMatch(/25 of 373 publications tagged Melanoma/);
  });

  it("publications:concept ⇒ the folded text variant", () => {
    renderEv({ kind: "publications", strength: "concept", text: "via related concept Melanoma" });
    expect(screen.getByText(/via related concept Melanoma/)).toBeTruthy();
  });

  it("name ⇒ matched term bold", () => {
    renderEv({ kind: "name", html: "Roel <mark>van Herten</mark> - AI In Medical Imaging" });
    expect(screen.getByText("van Herten").tagName).toBe("STRONG");
  });

  it("selfDescription ⇒ bio sentence, matched term bold", () => {
    renderEv({ kind: "selfDescription", html: "The lab studies <mark>RNA</mark> biology." });
    expect(screen.getByText("RNA").tagName).toBe("STRONG");
  });

  it("affiliation ⇒ rendered (weak), matched term bold", () => {
    renderEv({ kind: "affiliation", html: "AI In Medical <mark>Imaging</mark>" });
    expect(screen.getByText("Imaging").tagName).toBe("STRONG");
  });

  it("none ⇒ honest-empty line, no fabricated reason", () => {
    const { container } = renderEv({ kind: "none" });
    expect(container.textContent).toContain("no specific match");
  });
});

describe("<ResultEvidence> — E2 areas treatment (handoff §5#1)", () => {
  it("renders an empty match line PLUS a separate 'Areas' hint with '+N more'", () => {
    const { container } = renderEv({
      kind: "areas",
      labels: ["Metabolic & Endocrine Disease", "Mental Health & Psychiatry", "Single-Cell & Spatial Biology", "Genetics, Genomics & Precision Medicine"],
      total: 10,
    });
    // honest-empty "why" line
    expect(container.textContent).toContain("no specific match");
    // separate, labeled identity affordance
    expect(screen.getByText("Areas")).toBeTruthy();
    expect(screen.getByText("Metabolic & Endocrine Disease")).toBeTruthy();
    expect(screen.getByText("+6 more")).toBeTruthy();
  });

  it("no '+N more' when total equals the shown labels", () => {
    renderEv({ kind: "areas", labels: ["A", "B"], total: 2 });
    expect(screen.queryByText(/\+\d+ more/)).toBeNull();
  });
});

describe("<ResultEvidence> — DOM guardrails (would have caught #1051)", () => {
  it("a raw under_score slug never reaches the DOM via areas", () => {
    // Even if a slug slipped through upstream, the renderer must not be the place
    // it is humanized — but assert the contract: with humanized labels, no '_'.
    const { container } = renderEv({
      kind: "areas",
      labels: ["Single-Cell & Spatial Biology", "Lung Cancer"],
      total: 4,
    });
    expect(container.textContent).not.toMatch(/[a-z]_[a-z]/);
  });

  it("only the (already-capped) labels render — never an unbounded dump", () => {
    renderEv({
      kind: "areas",
      labels: ["A", "B", "C", "D"], // server caps to AREAS_CAP=4
      total: 10,
    });
    // The 5th+ labels are represented as "+N more", not enumerated.
    expect(screen.getByText("+6 more")).toBeTruthy();
    expect(screen.queryByText("E")).toBeNull();
  });
});

describe("<RepresentativePapers> — the disclosure stack", () => {
  const PAPERS = [
    { pmid: "1", title: "First representative paper", year: 2024 },
    { pmid: "2", title: "Second representative paper", year: 2023 },
    { pmid: "3", title: "Third representative paper", year: 2022 },
  ];

  it("renders the REP. PAPERS label + the (up to 3) italic titles with year", () => {
    render(<RepresentativePapers papers={PAPERS} total={3} profileHref="/p/jane#publications" />);
    expect(screen.getByText("Rep. papers")).toBeTruthy();
    expect(screen.getByText("First representative paper")).toBeTruthy();
    expect(screen.getByText("Third representative paper")).toBeTruthy();
    expect(screen.getByText(/\(2024\)/)).toBeTruthy();
  });

  it("uses the singular 'Rep. paper' label for a single paper", () => {
    render(<RepresentativePapers papers={[PAPERS[0]]} total={1} profileHref="/p/jane#publications" />);
    expect(screen.getByText("Rep. paper")).toBeTruthy();
    expect(screen.queryByText("Rep. papers")).toBeNull();
  });

  it("renders a '+N more in profile →' link to the profile when total exceeds the shown papers", () => {
    render(<RepresentativePapers papers={PAPERS} total={12} profileHref="/p/jane#publications" />);
    const more = screen.getByText(/\+9 more in profile/);
    expect(more.closest("a")?.getAttribute("href")).toBe("/p/jane#publications");
  });

  it("omits the '+N more' link when total equals the shown papers", () => {
    render(<RepresentativePapers papers={PAPERS} total={3} profileHref="/p/jane#publications" />);
    expect(screen.queryByText(/more in profile/)).toBeNull();
  });

  it("shows the loading placeholder while a lazy fetch is in flight (no papers yet)", () => {
    render(<RepresentativePapers papers={[]} total={0} profileHref="/p/jane#publications" status="loading" />);
    expect(screen.getByText(/finding representative papers/i)).toBeTruthy();
  });

  it("renders nothing once a fetch resolves with zero papers (never a dead block)", () => {
    const { container } = render(
      <RepresentativePapers papers={[]} total={0} profileHref="/p/jane#publications" status="done" />,
    );
    expect(container.textContent).toBe("");
  });
});
