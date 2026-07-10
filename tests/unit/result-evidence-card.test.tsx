/**
 * #824 follow-up Phase 1 — the single `<ResultEvidence>` renderer. One golden
 * render per kind, plus the E2 areas treatment and the DOM-level guardrails
 * (no raw slug leaks; bounded list).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ResultEvidence } from "@/components/search/result-evidence";
import { RepresentativePapers } from "@/components/search/match-reason";
import { EvidenceLine } from "@/components/search/evidence-line";
import type { ResultEvidence as Evidence } from "@/lib/api/result-evidence";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderEv = (evidence: Evidence, slug?: string) =>
  render(<ResultEvidence evidence={evidence} slug={slug} />);

describe("<ResultEvidence> — one render per kind", () => {
  it("method ⇒ Method type word + underlined family, with NO exemplar-tool trail", () => {
    renderEv({ kind: "method", family: "Single-cell RNA sequencing", tools: ["scRNA-seq", "10x"] });
    expect(screen.getByText("Method")).toBeTruthy();
    // #1381 — the entity is a subtly-underlined span (all kinds but keyword), not <strong>.
    const fam = screen.getByText("Single-cell RNA sequencing");
    expect(fam.tagName).toBe("SPAN");
    expect(fam.className).toMatch(/underline/);
    // The related-terms trail was dropped — the family name stands alone even when
    // the evidence object still carries tools (kept so it can be reinstated later).
    expect(screen.queryByText("scRNA-seq")).toBeNull();
    expect(screen.queryByText("10x")).toBeNull();
  });

  it("topic ⇒ Research area type word + underlined label", () => {
    renderEv({ kind: "topic", label: "Single-cell & spatial biology", id: "single_cell_spatial_biology" });
    expect(screen.getByText("Research area")).toBeTruthy();
    const label = screen.getByText("Single-cell & spatial biology");
    expect(label.tagName).toBe("SPAN");
    expect(label.className).toMatch(/underline/);
  });

  it("#1381 — the primary type indicator is a FILLED category dot (method = burnt umber), not a pill", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "CRISPR", tools: [], count: 4 }}
        pubCount={98}
        stacked
      />,
    );
    // method dot in burnt umber; the old bordered pill is gone.
    const dots = Array.from(container.querySelectorAll("span.rounded-full")).map((d) => d.className);
    expect(dots.some((c) => c.includes("bg-[#8B4A2F]"))).toBe(true);
    expect(container.innerHTML).not.toContain("rounded-[5px]");
    // count-first: emphasized count + muted "of 98 publications used" + underlined family.
    expect(screen.getByText("Method")).toBeTruthy();
    expect(container.textContent).toMatch(/4 of 98 publications used/);
    const fam = screen.getByText("CRISPR");
    expect(fam.tagName).toBe("SPAN");
    expect(fam.className).toMatch(/underline/);
  });

  it("#1381 — the badged publications primary is a dot + type word, not a flavor pill", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "mention",
          text: "1 of 98 publications mention",
          term: "crispr",
          count: 1,
        }}
        pubCount={98}
        stacked
        badged
      />,
    );
    const dots = Array.from(container.querySelectorAll("span.rounded-full")).map((d) => d.className);
    expect(dots.some((c) => c.includes("bg-[#64748b]"))).toBe(true); // keyword dot
    expect(screen.getByText("Keyword")).toBeTruthy();
    expect(container.innerHTML).not.toContain("rounded-[5px]");
  });

  it("#1391 — clinical primary ⇒ 'Clinical' type word + underlined specialty, NO count", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "clinical", specialty: "Cardiology", boardCertified: true }}
        pubCount={44}
        stacked
      />,
    );
    expect(screen.getByText("Clinical")).toBeTruthy();
    expect(container.textContent).toMatch(/Board certified in Cardiology/);
    // clinical carries no "N of M" count.
    expect(container.textContent).not.toMatch(/of 44/);
    // the specialty is the dotted-underline entity (every kind but keyword).
    const spec = screen.getByText("Cardiology");
    expect(spec.tagName).toBe("SPAN");
    expect(spec.className).toMatch(/underline/);
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
    // matched label PLUS the sr-only "key papers" affordance.
    expect(mBtn?.textContent).toMatch(/Flow cytometry/);
    expect(mBtn?.textContent).toMatch(/key papers/i);

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
    // #1381 — the leading count is its own emphasized span, so assert the whole phrase
    // on the concatenated text rather than a single element.
    expect(document.body.textContent).toMatch(/25 of 373 publications tagged Melanoma/);

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

  it("#1350 — a resolved concept term renders as its own subtly-underlined span", () => {
    renderEv({
      kind: "publications",
      strength: "tagged",
      text: "3 of 301 publications tagged",
      term: "Pharmacogenetics",
      count: 3,
    });
    expect(document.body.textContent).toMatch(/3 of 301 publications tagged/);
    const term = screen.getByText("Pharmacogenetics");
    expect(term.tagName).toBe("SPAN");
    expect(term.className).toMatch(/underline/);
  });

  it("#1355 — narrower descendant terms render after the concept term, capped at 2 + '+N more'", () => {
    renderEv({
      kind: "publications",
      strength: "concept",
      text: "via related concept",
      term: "Microbiota",
      descendantTerms: ["Mycobiome", "Virome", "Metagenome"],
    });
    expect(screen.getByText("Microbiota").className).toMatch(/underline/);
    expect(screen.getByText(/matched Mycobiome, Virome, \+1 more/)).toBeTruthy();
  });

  it("#1361 — a mention literal term is semibold but NOT underlined (underline = concept only)", () => {
    renderEv({
      kind: "publications",
      strength: "mention",
      text: "1 of 2 publications mention",
      term: "“16s rna”",
      count: 1,
    });
    const term = screen.getByText("“16s rna”");
    expect(term.className).toMatch(/font-semibold/);
    expect(term.className).not.toMatch(/underline/);
  });

  // #1361 — snippet/name/bio/affiliation marks now render as the SAME light-red
  // pill (a real <mark>) as titles, not a bold <strong>.
  it("name ⇒ matched term highlighted (pill)", () => {
    renderEv({ kind: "name", html: "Roel <mark>van Herten</mark> - AI In Medical Imaging" });
    expect(screen.getByText("van Herten").tagName).toBe("MARK");
  });

  it("selfDescription ⇒ bio sentence, matched term highlighted (pill)", () => {
    renderEv({ kind: "selfDescription", html: "The lab studies <mark>RNA</mark> biology." });
    expect(screen.getByText("RNA").tagName).toBe("MARK");
  });

  it("affiliation ⇒ rendered (weak), matched term highlighted (pill)", () => {
    renderEv({ kind: "affiliation", html: "AI In Medical <mark>Imaging</mark>" });
    expect(screen.getByText("Imaging").tagName).toBe("MARK");
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

describe("<ResultEvidence> — SEARCH_PEOPLE_CONCEPT_HINT concepts treatment", () => {
  const items6 = [
    { label: "Neoplasms", ui: "D009369" },
    { label: "Immunotherapy", ui: "D007167" },
    { label: "Melanoma", ui: "D008545" },
    { label: "T-Lymphocytes", ui: "D013601" },
    { label: "Antigens", ui: "D000941" },
    { label: "Mutation", ui: "D009154" },
  ];

  it("a concept WITH a ui deep-links to the scholar's pubs filtered to it", () => {
    renderEv({ kind: "concepts", items: items6.slice(0, 2), total: 2 }, "jane-smith");
    const chip = screen.getByText("Neoplasms").closest("a");
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute("href")).toBe("/jane-smith?mesh=D009369#publications");
  });

  it("a concept with a null ui renders as a NON-link chip", () => {
    renderEv({ kind: "concepts", items: [{ label: "Orphan Term", ui: null }], total: 1 }, "jane-smith");
    expect(screen.getByText("Orphan Term").closest("a")).toBeNull();
  });

  it("folds overflow into an expanding '+N more' BUTTON (jsdom fallback = 4 chips)", () => {
    renderEv({ kind: "concepts", items: items6, total: 6 }, "jane-smith");
    // No layout in jsdom → fallback shows 4 chips, the other 2 behind "+N more".
    const more = screen.getByRole("button", { name: /Show 2 more topics/ });
    expect(more.tagName).toBe("BUTTON"); // expands the row; never a link
  });

  it("no '+N more' when all concepts fit the fallback (<= 4)", () => {
    renderEv({ kind: "concepts", items: items6.slice(0, 3), total: 3 }, "jane-smith");
    expect(screen.queryByRole("button", { name: /more topic/ })).toBeNull();
  });

  it("no 'TOPICS' label or boxed container — the tag glyph carries the meaning", () => {
    renderEv({ kind: "concepts", items: items6.slice(0, 2), total: 2 }, "jane-smith");
    expect(screen.queryByText("TOPICS")).toBeNull();
  });
});

describe("<ResultEvidence> — hasQuery gate on the empty match line", () => {
  it("hasQuery=false: kind 'none' renders nothing", () => {
    const { container } = render(<ResultEvidence evidence={{ kind: "none" }} hasQuery={false} />);
    expect(container.textContent).toBe("");
    expect(container.textContent).not.toContain("no specific match");
  });

  it("hasQuery=false: kind 'concepts' renders the chips WITHOUT the empty line", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{
          kind: "concepts",
          items: [
            { label: "Neoplasms", ui: "D009369" },
            { label: "Melanoma", ui: "D008545" },
          ],
          total: 2,
        }}
        hasQuery={false}
        slug="jane-smith"
      />,
    );
    expect(container.textContent).not.toContain("no specific match");
    expect(screen.getByText("Neoplasms")).toBeTruthy();
  });

  it("hasQuery=false: kind 'areas' renders the hint WITHOUT the empty line", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "areas", labels: ["Lung Cancer"], total: 3 }}
        hasQuery={false}
      />,
    );
    expect(container.textContent).not.toContain("no specific match");
    expect(screen.getByText("Areas")).toBeTruthy();
  });

  it("hasQuery=true: kind 'none' STILL renders the honest-empty line", () => {
    const { container } = render(<ResultEvidence evidence={{ kind: "none" }} hasQuery />);
    expect(container.textContent).toContain("no specific match");
  });

  it("hasQuery=true: kind 'concepts' renders the empty line ABOVE the chips", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "concepts", items: [{ label: "Neoplasms", ui: "D009369" }], total: 1 }}
        hasQuery
        slug="jane-smith"
      />,
    );
    expect(container.textContent).toContain("no specific match");
    expect(screen.getByText("Neoplasms")).toBeTruthy();
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

  it("renders the KEY PAPERS label + the (up to 3) italic titles with year", () => {
    render(<RepresentativePapers papers={PAPERS} total={3} profileHref="/p/jane#publications" />);
    expect(screen.getByText("Key papers")).toBeTruthy();
    expect(screen.getByText("First representative paper")).toBeTruthy();
    expect(screen.getByText("Third representative paper")).toBeTruthy();
    expect(screen.getByText(/\(2024\)/)).toBeTruthy();
  });

  it("uses the singular 'Key paper' label for a single paper", () => {
    render(<RepresentativePapers papers={[PAPERS[0]]} total={1} profileHref="/p/jane#publications" />);
    expect(screen.getByText("Key paper")).toBeTruthy();
    expect(screen.queryByText("Key papers")).toBeNull();
  });

  it("renders a '+N more in profile →' link to the profile when total exceeds the shown papers", () => {
    render(<RepresentativePapers papers={PAPERS} total={12} profileHref="/p/jane#publications" />);
    const more = screen.getByText(/\+9 more in profile/);
    expect(more.closest("a")?.getAttribute("href")).toBe("/p/jane#publications");
  });

  it("no inline count in the header; truncation shows only via the '+N more' link", () => {
    const { rerender } = render(
      <RepresentativePapers papers={PAPERS} total={8} profileHref="/p/jane#publications" />,
    );
    // Sentence-case header carries no "N of M" count (approved) — the total lives in
    // the "+N more" link.
    expect(screen.queryByText("3 of 8")).toBeNull();
    expect(screen.getByText(/\+5 more in profile/)).toBeTruthy();
    rerender(<RepresentativePapers papers={PAPERS} total={3} profileHref="/p/jane#publications" />);
    expect(screen.queryByText(/more in profile/)).toBeNull();
  });

  it("omits the '+N more' link when total equals the shown papers", () => {
    render(<RepresentativePapers papers={PAPERS} total={3} profileHref="/p/jane#publications" />);
    expect(screen.queryByText(/more in profile/)).toBeNull();
  });

  it("shows the loading placeholder while a lazy fetch is in flight (no papers yet)", () => {
    render(<RepresentativePapers papers={[]} total={0} profileHref="/p/jane#publications" status="loading" />);
    expect(screen.getByText(/finding key papers/i)).toBeTruthy();
  });

  it("renders nothing once a fetch resolves with zero papers (never a dead block)", () => {
    const { container } = render(
      <RepresentativePapers papers={[]} total={0} profileHref="/p/jane#publications" status="done" />,
    );
    expect(container.textContent).toBe("");
  });

  it("highlights a query match in a Key-paper title with the light-red pill (titleHtml)", () => {
    // titleHtml carries <mark>s (OpenSearch for a tagged-pub match, or the topic/
    // method term-wrap); the disclosure must style them like the Publications tab.
    const { container } = render(
      <RepresentativePapers
        papers={[{ pmid: "1", title: "Stem cell biology", titleHtml: "<mark>Stem</mark> cell biology", year: 2024 }]}
        total={1}
        profileHref="/p/jane#publications"
      />,
    );
    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("Stem");
    expect(mark?.getAttribute("class")).toContain("bg-[#b31b1b]/10");
  });

  it("#1366 — renders the 'text mention, not a curated tag' honesty note when mentionNote", () => {
    render(
      <RepresentativePapers papers={PAPERS} total={3} profileHref="/p/x#publications" mentionNote />,
    );
    expect(screen.getByText(/text mention in the abstract, not a curated tag/i)).toBeTruthy();
  });

  it("#1366 — omits the honesty note by default", () => {
    const { container } = render(
      <RepresentativePapers papers={PAPERS} total={3} profileHref="/p/x#publications" />,
    );
    expect(container.textContent).not.toMatch(/not a curated tag/);
  });
});

describe("<ResultEvidence> — #1366 follow-up tiered 'Also matched' (tier='lesser')", () => {
  const dotOf = (c: HTMLElement) => c.querySelector("span.rounded-full");

  it("method lesser ⇒ a FILLED dot + 'Method · family' + '· N of M publications' (no badge pill)", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "CRISPR genome editing", tools: [], count: 3 }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/Method · CRISPR genome editing/);
    expect(container.textContent).toMatch(/· 3 of 44 publications/); // unit spelled out
    expect(dotOf(container)?.className).toMatch(/bg-\[#8B4A2F\]/); // filled burnt umber = curated
  });

  it("research area lesser ⇒ FILLED dot + 'Research area · label'", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "topic", label: "Stem Cell & Regenerative Medicine", id: "stem", count: 2 }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/Research area · Stem Cell & Regenerative Medicine/);
    expect(container.textContent).toMatch(/· 2 of 44/);
    expect(dotOf(container)?.className).toMatch(/bg-\[#2563eb\]/);
  });

  it("publications:mention lesser ⇒ a FILLED grey dot + 'Keyword' (Part C — no hollow dot)", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "publications", strength: "mention", text: "x", term: "crispr", count: 2 }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/Keyword/);
    // #1366 follow-up Part C — the mention dot is now FILLED grey (strength carried by
    // the muted/italic text + the MentionNote), NOT a hollow bordered dot.
    expect(dotOf(container)?.className).toMatch(/bg-\[#64748b\]/);
    expect(dotOf(container)?.className).not.toMatch(/border-\[1\.5px\]/);
  });

  it("publications:tagged lesser ⇒ a FILLED dot + 'Concept'", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "publications", strength: "tagged", text: "x", term: "Melanoma", count: 5 }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/Concept/);
    expect(dotOf(container)?.className).toMatch(/bg-\[#7c3aed\]/); // filled = curated tag
  });

  it("clinical lesser ⇒ label-only dot row, NO count", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "clinical", specialty: "Cardiology", boardCertified: false }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/Clinical · Cardiology/);
    expect(container.textContent).not.toMatch(/of 44/);
  });

  it("a lesser row still offers the disclosure chevron when canExpand", () => {
    const onToggle = () => {};
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Flow cytometry", tools: [], count: 1 }}
        pubCount={10}
        tier="lesser"
        canExpand
        onToggle={onToggle}
      />,
    );
    expect(container.querySelector("button")).toBeTruthy();
  });
});

describe("<ResultEvidence> — #1366 count suffix (method / research area)", () => {
  it("method with a count + pubCount renders '· N of M publications' after the family", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Anti-obesity pharmacotherapy", tools: [], count: 7 }}
        pubCount={41}
      />,
    );
    // #1381 count-first: emphasized count, muted "of 41 publications used", underlined family.
    const fam = screen.getByText("Anti-obesity pharmacotherapy");
    expect(fam.tagName).toBe("SPAN");
    expect(fam.className).toMatch(/underline/);
    expect(container.textContent).toMatch(/7 of 41 publications used Anti-obesity pharmacotherapy/);
  });

  it("research area with a count renders the count-first phrase too", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "topic", label: "Endocrinology", id: "endocrinology", count: 12 }}
        pubCount={41}
      />,
    );
    expect(container.textContent).toMatch(/12 of 41 publications in Endocrinology/);
  });

  it("no count (single-evidence path) ⇒ NO suffix — label-only, unchanged", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Flow cytometry", tools: [] }}
        pubCount={41}
      />,
    );
    expect(container.textContent).not.toMatch(/of 41 publications/);
  });
});

describe("<RepresentativePapers> — #1366 follow-up Part A panel relabeling", () => {
  const PAPERS = [
    { pmid: "1", title: "First paper", year: 2024 },
    { pmid: "2", title: "Second paper", year: 2023 },
  ];

  it("renders the caller-supplied panelLabel in place of the legacy 'Key papers'", () => {
    render(
      <RepresentativePapers
        papers={PAPERS}
        total={2}
        profileHref="/p/x#publications"
        panelLabel="Matching publications"
      />,
    );
    expect(screen.getByText("Matching publications")).toBeTruthy();
    expect(screen.queryByText("Key papers")).toBeNull();
  });

  it("folds panelSubtitle into the header as a muted, non-italic caveat (research-area panel)", () => {
    render(
      <RepresentativePapers
        papers={PAPERS}
        total={2}
        profileHref="/p/x#publications"
        panelLabel="Representative papers"
        panelSubtitle="not from your search"
      />,
    );
    expect(screen.getByText("Representative papers")).toBeTruthy();
    const sub = screen.getByText(/not from your search/i);
    // Folded inline as "· <caveat>", muted, no longer a separate italic line.
    expect(sub.textContent).toMatch(/·\s*not from your search/);
    expect(sub.className).toMatch(/text-\[#8c8c8c\]/);
    expect(sub.className).not.toMatch(/italic/);
  });

  it("omits the subtitle by default (method / publications panels)", () => {
    const { container } = render(
      <RepresentativePapers
        papers={PAPERS}
        total={2}
        profileHref="/p/x#publications"
        panelLabel="Matching publications"
      />,
    );
    expect(container.textContent).not.toMatch(/not matched to your search/);
  });

  it("still falls back to the legacy singular/plural 'Key paper(s)' when no panelLabel", () => {
    const { rerender } = render(
      <RepresentativePapers papers={PAPERS} total={2} profileHref="/p/x#publications" />,
    );
    expect(screen.getByText("Key papers")).toBeTruthy();
    rerender(<RepresentativePapers papers={[PAPERS[0]]} total={1} profileHref="/p/x#publications" />);
    expect(screen.getByText("Key paper")).toBeTruthy();
  });
});

describe("<EvidenceLine> — #1366 follow-up Part A derives the panel header from kind", () => {
  function mockFetch(payload: unknown) {
    const fn = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal("fetch", fn);
    return fn;
  }
  function renderLine(evidence: Evidence) {
    const claimedPmids = new Set<string>();
    return render(
      <EvidenceLine
        evidence={evidence}
        cwid="abc1234"
        slug="jane-doe"
        pubCount={50}
        q="x"
        keyPaperConfig={null}
        hasQuery
        badged
        claimedPmids={claimedPmids}
        stacked
        tier="primary"
      />,
    );
  }

  it("publications (inline pubs) → 'Matching publications', no subtitle", () => {
    renderLine({
      kind: "publications",
      strength: "tagged",
      text: "10 of 50 publications tagged Melanoma",
      count: 10,
      pubs: [{ pmid: "1", title: "A paper", year: 2024 }],
    });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Matching publications")).toBeTruthy();
    expect(screen.queryByText(/not from your search/)).toBeNull();
  });

  it("topic → 'Representative papers' + folded 'not from your search' caveat + blue rail", async () => {
    mockFetch({ pubs: [{ pmid: "1", title: "Top area paper", year: 2024 }], total: 1 });
    renderLine({ kind: "topic", label: "Stem Cell Biology", id: "stem", count: 10 });
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByText("Representative papers")).toBeTruthy());
    expect(screen.getByText(/not from your search/i)).toBeTruthy();
    // Headline: the expanded research-area panel carries the blue signal rail.
    expect(document.querySelector('[class*="border-[#2563eb]"]')).toBeTruthy();
  });

  it("single-evidence (stacked=false) keeps the legacy 'Key papers' header, not the relabel", () => {
    const claimedPmids = new Set<string>();
    render(
      <EvidenceLine
        evidence={{
          kind: "publications",
          strength: "tagged",
          text: "10 of 50 publications tagged Melanoma",
          count: 10,
          pubs: [{ pmid: "1", title: "A paper", year: 2024 }],
        }}
        cwid="abc1234"
        slug="jane-doe"
        pubCount={50}
        q="x"
        keyPaperConfig={null}
        hasQuery
        badged
        claimedPmids={claimedPmids}
        stacked={false}
        tier="primary"
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    // legacy fallback is count-aware; one inline pub → singular "Key paper".
    expect(screen.getByText("Key paper")).toBeTruthy();
    expect(screen.queryByText("Matching publications")).toBeNull();
  });
});

describe("<ResultEvidence> — #1366 follow-up Part B relevance cues on the primary lead", () => {
  it("a low-coverage method primary (<2%) gets a '% of output' cue and is dimmed", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Mass spectrometry", tools: [], count: 1 }}
        pubCount={538}
        stacked
      />,
    );
    // 1/538 = 0.19% → fires; the family label drops from near-black to muted grey.
    expect(container.textContent).toMatch(/· 0\.2% of output/);
    expect(screen.getByText("Mass spectrometry").className).toMatch(/text-\[#9a958a\]/);
  });

  it("a coverage that rounds below 0.1% displays '<0.1% of output'", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Imaging mass cytometry", tools: [], count: 1 }}
        pubCount={3000}
        stacked
      />,
    );
    expect(container.textContent).toMatch(/<0\.1% of output/);
  });

  it("a keyword-only primary gets 'term match only', stays dimmed, KEEPS the Keyword pill, and never stacks the coverage cue", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "mention",
          text: "1 of 538 publications mention",
          term: "crispr",
          count: 1,
        }}
        pubCount={538}
        stacked
        badged
      />,
    );
    expect(screen.getByText("Keyword")).toBeTruthy(); // the type word is retained (now a dot, not a pill)
    expect(container.textContent).toMatch(/· term match only/);
    // precedence: keyword-only wins; the low-coverage cue is NOT also appended.
    expect(container.textContent).not.toMatch(/% of output/);
    // dim: the reason text drops to muted grey (the term span inherits it).
    expect(screen.getByText("crispr").className).toMatch(/text-\[#9a958a\]/);
  });

  it("a normal-coverage primary shows NEITHER cue and is NOT dimmed", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Flow cytometry", tools: [], count: 4 }}
        pubCount={98}
        stacked
      />,
    );
    // 4/98 = 4.1% ≥ 2% → no cue; the label stays near-black.
    expect(container.textContent).not.toMatch(/of output/);
    expect(screen.getByText("Flow cytometry").className).toMatch(/text-\[#1a1a1a\]/);
    expect(screen.getByText("Flow cytometry").className).not.toMatch(/text-\[#9a958a\]/);
  });

  it("the single-evidence path (stacked omitted) shows NO cue and is NOT dimmed, even at low coverage", () => {
    // Same 1/538 = 0.19% lead as the first test, but without `stacked` → the cue is
    // gated off so the single-evidence render stays visually frozen (matches C/D).
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Mass spectrometry", tools: [], count: 1 }}
        pubCount={538}
      />,
    );
    expect(container.textContent).not.toMatch(/of output/);
    expect(screen.getByText("Mass spectrometry").className).not.toMatch(/text-\[#9a958a\]/);
  });
});
