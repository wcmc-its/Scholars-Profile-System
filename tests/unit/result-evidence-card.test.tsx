/**
 * #824 follow-up Phase 1 — the single `<ResultEvidence>` renderer. One golden
 * render per kind, plus the E2 areas treatment and the DOM-level guardrails
 * (no raw slug leaks; bounded list).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultEvidence } from "@/components/search/result-evidence";
import type { ResultEvidence as Evidence } from "@/lib/api/result-evidence";

const renderEv = (evidence: Evidence) => render(<ResultEvidence evidence={evidence} />);

describe("<ResultEvidence> — one render per kind", () => {
  it("method ⇒ Method badge, bold family, dot-separated tools", () => {
    renderEv({ kind: "method", family: "Single-cell RNA sequencing", tools: ["scRNA-seq", "10x"] });
    expect(screen.getByText("Method")).toBeTruthy();
    expect(screen.getByText("Single-cell RNA sequencing").tagName).toBe("STRONG");
    expect(screen.getByText("scRNA-seq")).toBeTruthy();
    expect(screen.getByText("10x")).toBeTruthy();
  });

  it("topic ⇒ Topic badge + bold label", () => {
    renderEv({ kind: "topic", label: "Single-cell & spatial biology", id: "single_cell_spatial_biology" });
    expect(screen.getByText("Topic")).toBeTruthy();
    expect(screen.getByText("Single-cell & spatial biology").tagName).toBe("STRONG");
  });

  it("shows the ▾ disclosure cue on method AND topic badges when exemplarExpandable", () => {
    // The chevron (a rotating svg) is the hover cue for the representative-paper
    // reveal; it must appear for both kinds, and only when expandable.
    const { container: m } = render(
      <ResultEvidence evidence={{ kind: "method", family: "Flow cytometry", tools: [] }} exemplarExpandable />,
    );
    expect(m.querySelector('[class*="rotate-180"]')).toBeTruthy();

    const { container: t } = render(
      <ResultEvidence
        evidence={{ kind: "topic", label: "Immunology", id: "immunology" }}
        exemplarExpandable
      />,
    );
    expect(t.querySelector('[class*="rotate-180"]')).toBeTruthy();

    // Off ⇒ no chevron.
    const { container: off } = render(
      <ResultEvidence evidence={{ kind: "topic", label: "Immunology", id: "immunology" }} />,
    );
    expect(off.querySelector('[class*="rotate-180"]')).toBeNull();
  });

  it("publications:tagged ⇒ count line (C1, count only)", () => {
    renderEv({ kind: "publications", strength: "tagged", text: "25 of 373 publications tagged Melanoma" });
    expect(screen.getByText(/25 of 373 publications tagged Melanoma/)).toBeTruthy();
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
