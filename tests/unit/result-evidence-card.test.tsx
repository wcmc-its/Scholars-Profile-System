/**
 * #824 follow-up Phase 1 — the single `<ResultEvidence>` renderer. One golden
 * render per kind, plus the E2 areas treatment and the DOM-level guardrails
 * (no raw slug leaks; bounded list).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/**
 * Uniform fold rule — the provenance pills, found by their shared shape.
 *
 * This exists because the #1913 "no pill" guards below CANNOT do it any more: every one of
 * them is `querySelectorAll("span.rounded-full").length === 0`, and the provenance pill is
 * `rounded-[3px]`, so all of them stay green whether a pill is present or not. Counting by
 * shape and asserting the WORDS is what still fails loudly if a per-category pill returns
 * — the axis #1913 retired — since a category pill would push the count past the
 * provenance one this row is entitled to.
 */
const pillsIn = (c: HTMLElement): string[] =>
  Array.from(c.querySelectorAll('span[class*="rounded-[3px]"]')).map((n) => n.textContent ?? "");

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

  it("#1913 — the primary type indicator is the WORD alone: no category dot, no pill", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "CRISPR", tools: [], count: 4 }}
        pubCount={98}
        stacked
      />,
    );
    // No dot of any hue, and the old bordered pill stays gone.
    expect(container.querySelectorAll("span.rounded-full").length).toBe(0);
    expect(container.innerHTML).not.toContain("rounded-[5px]");
    // and specifically none of the retired category hues survive anywhere in the row.
    for (const hue of ["#8B4A2F", "#2563eb", "#0891b2", "#7c3aed", "#64748b", "#16a34a"]) {
      expect(container.innerHTML).not.toContain(hue);
    }
    // …and method carries NO pill of any kind: it has no `strength` field, so there is no
    // provenance datum, and painting every non-mention lead green would resolve one value
    // across ~98% of rows — the exact failure #1913 retired.
    expect(pillsIn(container)).toEqual([]);
    // count-first: emphasized count + muted "of 98 publications used" + underlined family.
    expect(screen.getByText("Method")).toBeTruthy();
    expect(container.textContent).toMatch(/4 of 98 publications used/);
    const fam = screen.getByText("CRISPR");
    expect(fam.tagName).toBe("SPAN");
    expect(fam.className).toMatch(/underline/);
  });

  it("#1913 — the badged publications primary is the type word alone, no dot, no per-CATEGORY pill", () => {
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
    expect(container.querySelectorAll("span.rounded-full").length).toBe(0);
    expect(container.innerHTML).not.toContain("#64748b");
    expect(screen.getByText("Keyword")).toBeTruthy();
    expect(container.innerHTML).not.toContain("rounded-[5px]");
    // Uniform fold rule — this fixture DOES now carry a pill, so the guards above no longer
    // prove "no pill" on their own. Pin the exact inventory: one PROVENANCE pill (this lead
    // is a literal mention) and nothing else. A returning category pill fails here.
    expect(pillsIn(container)).toEqual(["keyword only"]);
  });

  it("#1922 follow-up — a non-dim primary accents its kind word AND its count, on both phrase paths", () => {
    // The one `--evidence-accent` is what makes the lead read as the lead. Both halves
    // of it are pinned on both phrase builders, because the publications branch writes
    // its count-first phrase inline instead of going through CountFirst.
    render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "tagged",
          text: "12 of 98 publications tagged",
          term: "Melanoma",
          count: 12,
        }}
        pubCount={98}
        stacked
      />,
    );
    expect(screen.getByText("Concept").className).toContain("--evidence-accent");
    expect(screen.getByText("12").className).toContain("--evidence-accent");
    // …and the CountFirst phrase that method/topic/funding share.
    render(
      <ResultEvidence
        evidence={{ kind: "method", family: "CRISPR", tools: [], count: 4 }}
        pubCount={98}
        stacked
      />,
    );
    expect(screen.getByText("Method").className).toContain("--evidence-accent");
    expect(screen.getByText("4").className).toContain("--evidence-accent");
  });

  it("#1922 follow-up — a DIM primary takes no accent at all: a thin match stays faint", () => {
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
      />,
    );
    // Uniform fold rule — the two "the fixture really IS the dim lead" proofs were the cue
    // strings, which are retired. Re-keyed onto their replacements: the amber pill for a
    // keyword-only lead, the % column for a low-coverage one. The accent assertions below
    // are untouched and still hold — the pill uses the apollo tokens and the % uses
    // `--evidence-body`, so neither reintroduces the accent a dim lead must not have.
    expect(pillsIn(container)).toEqual(["keyword only"]); // it really is the dim lead
    expect(container.innerHTML).not.toContain("--evidence-accent");
    // …and the CountFirst dim gate, which is a SEPARATE line from the inline one above:
    // without this, dropping `dim ?` in CountFirst survives the whole suite green.
    const method = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Mass spectrometry", tools: [], count: 1 }}
        pubCount={538}
        stacked
      />,
    );
    expect(method.container.textContent).toMatch(/0\.2%/); // it really is dim
    expect(method.container.innerHTML).not.toContain("--evidence-accent");
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

  it("#1355 — narrower descendant terms render on the 'via' LINE, capped at 2 + a prose tail", () => {
    renderEv({
      kind: "publications",
      strength: "concept",
      text: "via related concept",
      term: "Microbiota",
      descendantTerms: ["Mycobiome", "Virome", "Metagenome"],
    });
    expect(screen.getByText("Microbiota").className).toMatch(/underline/);
    // Uniform fold rule — was the inline "(matched … · +1 more)" parenthetical. Same datum,
    // same cap, own line; the "+N more" truncation notice becomes prose because on its own
    // line the list is not truncated, it is summarising a set. Singular for exactly one.
    // #1908 — middot-separated, not comma-separated (see the MeSH case below).
    const via = screen.getByText("Mycobiome · Virome and 1 related term");
    // The prefix is the RENDERER's, not the caller's (`descendantViaSummary` omits it,
    // exactly as `descendantSummary` omits its "(matched " wrapper). It NAMES the
    // relationship: "via X" left the reader to infer that X was a narrower term rolling up
    // to their query, which is the one thing the line exists to say. #1955 kept that
    // property and scoped the claim to where it holds — no `alsoParent` here, so the parent
    // tag is absent from this scholar's INDEXED descriptor set (weaker than absent; see the
    // min-evidence caveat on `MatchProvenance.alsoParent`).
    expect(via.textContent).toBe("matched on narrower term Mycobiome · Virome and 1 related term");
  });

  it("#1955 — a scholar who ALSO carries the parent gets the additive wording instead", () => {
    // The other half of the same line, and the reason it is two strings rather than one.
    // Same shape as the test above, one field different. "matched on narrower term" would
    // over-claim here (`computeMatchProvenance` prefers the narrower framing on CARRYING a
    // descendant, so it cannot know the match came through one).
    // The verb is load-bearing. Read the assembled card: line 1 ends on the styled TERM, so
    // a subjectless second line takes THAT as its antecedent — "also includes" would say
    // "Leukemia also includes Leukemia, Hairy Cell", a fact about the MeSH tree that is
    // equally true of every scholar on the page. "also tagged" echoes line 1's own verb, so
    // the subject is this scholar's publications, and it claims presence without claiming
    // proportion (nothing splits the 152 between parent- and descendant-tagged pubs).
    renderEv({
      kind: "publications",
      strength: "tagged",
      text: "152 of 250 publications tagged",
      term: "Leukemia",
      count: 152,
      descendantTerms: ["Leukemia, Hairy Cell", "Leukemia, Myeloid"],
      alsoParent: true,
    });
    const via = screen.getByText("Leukemia, Hairy Cell · Leukemia, Myeloid");
    expect(via.textContent).toBe("also tagged Leukemia, Hairy Cell · Leukemia, Myeloid");
  });

  it("#1955 — the additive wording still predicates of the SCHOLAR on the uncounted `concept` lead", () => {
    // The harder of the two leads: "via related concept Leukemia" carries no count and no
    // publication set, so a taxonomy reading of the second line would be the only one on
    // offer — which is exactly what sank "also includes". "tagged" is not a relation one
    // descriptor can bear to another, so the sentence still resolves to the scholar.
    renderEv({
      kind: "publications",
      strength: "concept",
      text: "via related concept",
      term: "Leukemia",
      descendantTerms: ["Leukemia, Hairy Cell", "Leukemia, Myeloid"],
      alsoParent: true,
    });
    const via = screen.getByText("Leukemia, Hairy Cell · Leukemia, Myeloid");
    expect(via.textContent).toBe("also tagged Leukemia, Hairy Cell · Leukemia, Myeloid");
  });

  it("#1908 — comma-inverted MeSH descriptors stay countable (the separator is not a comma)", () => {
    renderEv({
      kind: "publications",
      strength: "tagged",
      text: "152 of 250 publications tagged",
      term: "Leukemia",
      count: 152,
      // Real staging data. Joined on ", " these two terms rendered as six.
      // Exactly two, so the SEPARATOR is on screen to be asserted: a third would push the
      // rendered line past the via budget (see descendant-summary.test.ts) and roll the
      // second term into the prose tail, leaving nothing joined to check.
      descendantTerms: ["Leukemia, Hairy Cell", "Leukemia, Myeloid"],
    });
    expect(screen.getByText("Leukemia, Hairy Cell · Leukemia, Myeloid")).toBeTruthy();
  });

  it("#1907 — an over-budget descendant list drops WHOLE terms into the prose tail", () => {
    renderEv({
      kind: "publications",
      strength: "tagged",
      text: "26 of 169 publications tagged",
      term: "Leukemia",
      count: 26,
      descendantTerms: [
        "Precursor Cell Lymphoblastic Leukemia-Lymphoma",
        "Leukemia, Lymphocytic, Chronic, B-Cell",
        "Leukemia, Myeloid",
      ],
    });
    // 46 + 3 + 38 = 87 > the via-line's 72-char budget. The drop-whole-terms property
    // survives the move to a wider box and a different budget: one term shows, the rest
    // roll into the tail, rather than the line clipping mid-descriptor.
    expect(
      screen.getByText("Precursor Cell Lymphoblastic Leukemia-Lymphoma and 2 related terms"),
    ).toBeTruthy();
  });

  it("uniform fold rule — NO 'via' line when the concept matched directly (no descendants)", () => {
    // The gate is the datum's presence, nothing else. Without this, rendering the line
    // unconditionally would ship a bare "via" prefix on every direct concept match.
    const { container } = renderEv({
      kind: "publications",
      strength: "tagged",
      text: "3 of 301 publications tagged",
      term: "Pharmacogenetics",
      count: 3,
    });
    expect(container.textContent).not.toMatch(/via/);
  });

  it("uniform fold rule — the 'via' line sits UNDER the phrase, not inside it", () => {
    const { container } = renderEv({
      kind: "publications",
      strength: "tagged",
      text: "152 of 250 publications tagged",
      term: "Leukemia",
      count: 152,
      descendantTerms: ["Leukemia, Hairy Cell", "Leukemia, Myeloid"],
    });
    const via = screen.getByText("Leukemia, Hairy Cell · Leukemia, Myeloid");
    // #1963 — located as the first child of the baseline row rather than by `.truncate`,
    // which the phrase no longer carries. Deliberately NOT derived from `via`: the point of
    // this test is where `via` sits relative to the phrase, so deriving one from the other
    // would make the assertion circular.
    const phrase = container.querySelector(".items-baseline")?.firstElementChild ?? null;
    // A real second line: the via-span is a SIBLING of the phrase span inside a flex-col
    // body, not a trailing child of it. If it were a child, it would be on line 1 and
    // inside the #1907 clip — which is precisely where it used to be.
    expect(phrase).not.toBeNull();
    expect(phrase!.textContent).toMatch(/^152 of 250 publications tagged/);
    expect(via.parentElement).toBe(phrase!.parentElement!.parentElement);
    expect(via.parentElement!.className).toMatch(/flex-col/);
    expect(via.previousElementSibling).toBe(phrase!.parentElement);
  });

  it("#1963 — the phrase WRAPS rather than clipping, so a long concept term keeps its tail", () => {
    // The clip did not shorten the label, it renamed the disease: measured on staging,
    // `Precursor Cell Lymphoblastic Leukemia-Lymphoma` rendered as
    // `…Precursor Cell Lymphoblastic Leukemia…` at 1138px (6 of 6 cards) and every one of
    // 20 cards clipped at 433px. MeSH names are comma- and hyphen-inverted, so the part
    // that disambiguates them is the part a tail-clip takes.
    const { container } = renderEv({
      kind: "publications",
      strength: "tagged",
      text: "6 of 250 publications tagged",
      term: "Precursor Cell Lymphoblastic Leukemia-Lymphoma",
      count: 6,
    });
    const phrase = container.querySelector(".items-baseline")!.firstElementChild as HTMLElement;
    // jsdom has no layout, so the clip itself is unobservable here — what IS observable, and
    // what caused it, is the class. `truncate` is overflow-hidden + nowrap + ellipsis; absent
    // it, the phrase wraps and the tail survives at every width.
    expect(phrase.className).not.toMatch(/truncate/);
    // The whole term reaches the DOM — nothing upstream is pre-shortening it.
    expect(phrase.textContent).toContain("Precursor Cell Lymphoblastic Leukemia-Lymphoma");
    // …and the #1907 invariant still holds: the phrase is the item that yields, so the
    // trailing occupants keep max-content. It yields by wrapping now instead of hiding.
    expect(phrase.className).toMatch(/min-w-0/);
  });

  it("#1960 — the prefix and the term assemble into one sentence, with the space", () => {
    // `text` is only the PREFIX and `term` is a separate styled span, so the sentence the
    // reader sees exists only after the renderer joins them. Nothing asserted that join,
    // which is how "tagged under" + "Melanoma" could have shipped as "tagged underMelanoma"
    // — a defect invisible to every builder-side test, since each pins its own half.
    const { container } = renderEv({
      kind: "publications",
      strength: "tagged",
      text: "12 of 98 publications tagged under",
      term: "Melanoma",
      count: 12,
    });
    const phrase = container.querySelector(".items-baseline")!.firstElementChild as HTMLElement;
    expect(phrase.textContent).toBe("12 of 98 publications tagged under Melanoma");
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

  it("#1923 — an expanded panel NEVER renders empty; a zero-paper resolve still says something", () => {
    // This asserted `textContent === ""`. Rendering nothing is what made the chevron a
    // dead control: a user clicked and got silence, which reads as a broken page.
    const { container } = render(
      <RepresentativePapers papers={[]} total={0} profileHref="/p/jane#publications" status="done" />,
    );
    expect(container.textContent?.trim()).toMatch(/No separate papers to show for this match/i);
  });

  it("#1923 — a de-dup empty says where the papers actually went", () => {
    const { container } = render(
      <RepresentativePapers
        papers={[]}
        total={0}
        profileHref="/p/jane#publications"
        status="done"
        dedupedEmpty
      />,
    );
    // The papers are not missing, they are on screen under a stronger match on the same
    // card. That is worth saying rather than hiding.
    expect(container.textContent).toMatch(/already listed above, under a stronger match/i);
    expect(container.textContent).not.toMatch(/No separate papers/i);
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
  // #1913 — every lesser row lost its category dot. Kept as a NEGATIVE assertion so a
  // reintroduced dot fails loudly rather than passing unnoticed.
  //
  // Uniform fold rule — `dotOf` alone NO LONGER PROVES "no pill": it only looks for
  // `rounded-full`, and the provenance pill is `rounded-[3px]`, so a per-category pill in
  // that shape would sail straight past it. Every fixture below therefore also pins its
  // `pillsIn` inventory. Lesser rows get NO provenance pill except the clinical
  // `credential` one — this is the tier the fold reveals, not a place to re-add signals.
  const dotOf = (c: HTMLElement) => c.querySelector("span.rounded-full");

  it("method lesser ⇒ 'Method · family' + a MAGNITUDE, no share, no dot and no badge pill", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "CRISPR genome editing", tools: [], count: 3 }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/Method.?CRISPR genome editing/);
    // `methodFamilyCounts` is precomputed at index time and is NOT query-filtered, so it
    // cannot wear the "N of M" share frame the query-relative publications count wears —
    // side by side they read as one scale and are not. Magnitude, no denominator.
    expect(container.textContent).toMatch(/· 3 publications/);
    expect(container.textContent).not.toMatch(/of 44/);
    expect(dotOf(container)).toBeNull();
    expect(pillsIn(container)).toEqual([]);
  });

  it("every lesser kind puts its label in the SAME 108px column, and the entity outside it", () => {
    // The alignment is arithmetic, not taste: the panel's 16px indent + this 108px column +
    // the row's 7px gap equals the primary lead's 124px column + 7px gap, which is what puts
    // "Prostate & Urologic Cancer" at the same x as "168 of 529 publications tagged".
    // Three things can silently break it and all three are asserted here — a kind rendering
    // its label back inside `children`, a kind picking a different width, and a future label
    // longer than 108px pushing its own column open. jsdom computes no layout, so this pins
    // the class contract the Chromium measurement rests on.
    const kinds = [
      { evidence: { kind: "method", family: "CRISPR genome editing", tools: [], count: 3 }, word: "Method" },
      { evidence: { kind: "topic", label: "Immunology", id: "immuno", count: 2 }, word: "Research area" },
      { evidence: { kind: "clinical", specialty: "Cardiology", boardCertified: true }, word: "Clinical" },
      {
        evidence: { kind: "publications", strength: "tagged", text: "5 of 44 publications tagged", term: "Melanoma", count: 5 },
        word: "Concept",
      },
    ] as const;
    for (const { evidence, word } of kinds) {
      const { container, unmount } = render(
        <ResultEvidence evidence={evidence as Evidence} pubCount={44} tier="lesser" />,
      );
      const label = within(container).getByText(word);
      expect(label.className, `${word} label column`).toMatch(/lg:w-\[108px\]/);
      expect(label.className, `${word} must not shrink`).toMatch(/shrink-0/);
      // …and the entity is a SIBLING of the column, never inside it — inside, it would ride
      // the label's width and the column would buy nothing.
      expect(label.textContent).toBe(word);
      unmount();
    }
  });

  it("the label→entity separator exists ONLY below `lg`, where there is no column", () => {
    // With the column live the middot is noise; without it (narrow, same degradation as the
    // lead's kind word) label and entity would read as one phrase across a 7px gap.
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "topic", label: "Immunology", id: "immuno", count: 2 }}
        pubCount={44}
        tier="lesser"
      />,
    );
    const sep = [...container.querySelectorAll("span")].find((s) => s.textContent === "·");
    expect(sep, "no separator rendered at all").toBeTruthy();
    expect(sep!.className).toMatch(/lg:hidden/);
    expect(sep!.getAttribute("aria-hidden")).toBe("true");
  });

  it("the PUBLICATIONS lesser row KEEPS its denominator — that count IS query-relative", () => {
    // The discriminating half of the change. This numerator answers the question the
    // denominator frames ("how much of this scholar's output is about what I searched
    // for"), so its share is meaningful and stays. Drop this and the rule collapses into
    // "no denominators anywhere", which loses the only honest one.
    const { container } = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "tagged",
          text: "12 of 44 publications tagged",
          term: "Melanoma",
          count: 12,
        }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/· 12 of 44 publications/);
  });

  it("a scholar-scoped magnitude of exactly 1 says 'publication', not 'publications'", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "topic", label: "Immunology", id: "immuno", count: 1 }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/· 1 publication(?!s)/);
  });

  it("research area lesser ⇒ 'Research area · label', no dot", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "topic", label: "Stem Cell & Regenerative Medicine", id: "stem", count: 2 }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/Research area.?Stem Cell & Regenerative Medicine/);
    // Same as method: `areaCounts` is the scholar's total in the area, unchanged by the
    // query that selected the area. It states a magnitude, never a share of output.
    expect(container.textContent).toMatch(/· 2 publications/);
    expect(container.textContent).not.toMatch(/of 44/);
    expect(dotOf(container)).toBeNull();
    expect(pillsIn(container)).toEqual([]);
  });

  it("publications:mention lesser ⇒ 'Keyword', weakness carried by muted text not a dot", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "publications", strength: "mention", text: "x", term: "crispr", count: 2 }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/Keyword/);
    // #1913 — strength is carried by the muted/italic text + the MentionNote, which is
    // where it always actually lived; there is no dot to carry it.
    expect(dotOf(container)).toBeNull();
    expect(pillsIn(container)).toEqual([]);
  });

  it("publications:tagged lesser ⇒ 'Concept', no dot", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "publications", strength: "tagged", text: "x", term: "Melanoma", count: 5 }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/Concept/);
    expect(dotOf(container)).toBeNull();
    expect(pillsIn(container)).toEqual([]);
  });

  it("#1922 follow-up — an 'Also matched' row carries NO primary accent", () => {
    // The accent is the ONLY thing separating the lead from these rows; if it ever leaks
    // down here the stack goes tonally flat again and we are back to #1922. Negative, for
    // the same reason the dot guards above are.
    const { container } = render(
      <>
        <ResultEvidence
          evidence={{ kind: "method", family: "CRISPR genome editing", tools: [], count: 3 }}
          pubCount={44}
          tier="lesser"
        />
        <ResultEvidence
          evidence={{ kind: "publications", strength: "tagged", text: "5 of 44 publications tagged", term: "Melanoma", count: 5 }}
          pubCount={44}
          tier="lesser"
        />
      </>,
    );
    expect(container.textContent).toMatch(/Method.?CRISPR genome editing/);
    expect(container.textContent).toMatch(/Concept.?Melanoma/);
    expect(container.innerHTML).not.toContain("--evidence-accent");
  });

  it("clinical lesser ⇒ label-only dot row, NO count", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "clinical", specialty: "Cardiology", boardCertified: false }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/Clinical.?Cardiology/);
    expect(container.textContent).not.toMatch(/of 44/);
    expect(pillsIn(container)).toEqual([]);
  });

  it("uniform fold rule — a board-certified clinical lesser row carries the 'credential' pill", () => {
    // Decision 5 / the mockup: clinical is normally a SECONDARY, so the row the fold reveals
    // is where the pill has to land. It is NOT `stacked`-gated — it renders a flag the
    // evidence already carries rather than adding a new signal — and it is a shrink-0
    // SIBLING of the truncating span, per #1907.
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "clinical", specialty: "Hematology", boardCertified: true }}
        pubCount={44}
        tier="lesser"
      />,
    );
    expect(container.textContent).toMatch(/Board certified in Hematology/);
    expect(pillsIn(container)).toEqual(["credential"]);
    const pill = screen.getByText("credential");
    expect(pill.className).toMatch(/shrink-0/);
    let node = pill.parentElement;
    while (node && node !== container) {
      expect(node.className).not.toMatch(/truncate/);
      node = node.parentElement;
    }
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
    expect(sub.className).toMatch(/text-\[var\(--evidence-faint\)\]/);
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
    // #1913 — the rail is neutral now; it ties panel to row by position, not hue.
    expect(document.querySelector('[class*="border-[#a8a294]"]')).toBeTruthy();
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

  // MATCHA_GLOSS_INWORDS — the artifact-lead path is the ONLY consumer of `titleHtml` on the Matcha
  // panel, and it used to render it through `PubTitle` → `sanitizePubmedHtml`, whose whitelist is
  // i/em/b/strong/sup/sub. That DELETED every <mark>, so both the #1351 concept mark and the gloss
  // mark were invisible: the query and the cached fragment changed and nothing reached the screen.
  // This is the regression pin — it fails if the render ever leaves the mark-preserving path.
  it("artifactLead keeps a <mark> in titleHtml (pale-red pill), not stripped by the sanitizer", () => {
    const claimedPmids = new Set<string>();
    const { container } = render(
      <EvidenceLine
        evidence={{
          kind: "publications",
          strength: "tagged",
          text: "10 of 50 publications tagged Melanoma",
          count: 10,
          pubs: [
            {
              pmid: "1",
              title: "Durable responses in melanoma",
              titleHtml: "<mark>Durable</mark> responses in melanoma",
              year: 2024,
            },
          ],
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
        artifactLead
      />,
    );
    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("Durable");
    // The SAME pill the key-papers disclosure and the Publications tab use.
    expect(mark?.getAttribute("class")).toContain("bg-[#b31b1b]/10");
  });

  it("artifactLead falls back to the sanitized plain title when there is no titleHtml", () => {
    const claimedPmids = new Set<string>();
    const { container } = render(
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
        artifactLead
      />,
    );
    expect(container.querySelector("mark")).toBeNull();
    expect(screen.getByText("A paper")).toBeTruthy();
  });
});

describe("<ResultEvidence> — #1366 follow-up Part B relevance signals on the primary lead", () => {
  it("a low-coverage method primary (<2%) is still DIMMED, with the cue string gone", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Mass spectrometry", tools: [], count: 1 }}
        pubCount={538}
        stacked
      />,
    );
    // Uniform fold rule — `dim` no longer means "a cue string exists"; it reads the same
    // thinness test directly. 1/538 = 0.19% → still fires, and the family label still drops
    // from near-black to muted grey. What changed is that the caveat PROSE is retired: the
    // number moved to the always-on column, so nothing trails the phrase.
    expect(screen.getByText("Mass spectrometry").className).toMatch(
      /text-\[var\(--evidence-body\)\]/,
    );
    expect(container.textContent).not.toMatch(/of output/);
    expect(container.textContent).not.toMatch(/term match only/);
    // and the percentage is on the row, as the column's value.
    expect(screen.getByText("0.2%")).toBeTruthy();
  });

  it("#1912 — the NON-dim phrase body renders on the AA ramp, never the retired literals", () => {
    // The dim path had assertions; the ordinary path did not, so reverting the muted
    // tone to the failing #8c8c8c passed the whole suite. This is that guard.
    const { container } = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "tagged",
          text: "152 of 250 publications tagged",
          term: "Leukemia",
          count: 152,
        }}
        pubCount={250}
        stacked
      />,
    );
    const muted = screen.getByText(/of 250 publications tagged/);
    expect(muted.className).toMatch(/text-\[var\(--evidence-body\)\]/);
    // Every tone that failed WCAG AA on this row is gone from the markup entirely.
    for (const failing of ["#8c8c8c", "#9a958a", "#6b7280", "#bdbdbd", "#a9a399", "#c9c4ba"]) {
      expect(container.innerHTML).not.toContain(failing);
    }
  });

  it("#1907 — the pill AND the % cell sit OUTSIDE the truncating span, so a long phrase cannot clip them", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "tagged",
          text: "2 of 114 publications tagged",
          term: "Leukemia",
          count: 2,
          descendantTerms: ["Leukemia, Lymphoid", "Leukemia, Myeloid", "Leukemia, B-Cell"],
        }}
        pubCount={114}
        stacked
      />,
    );
    // Uniform fold rule — the cue this guard was written for is retired, and its slot is now
    // occupied by two elements. Both inherit the invariant, so both get the walk. When the
    // cue lived inside the truncating span, this exact row rendered dim with the sentence
    // explaining the dimming cut off at the pixel boundary.
    const noTruncateAncestry = (from: HTMLElement) => {
      let node: HTMLElement | null = from;
      while (node && node !== container) {
        expect(node.className).not.toMatch(/truncate/);
        node = node.parentElement;
      }
    };
    const pct = screen.getByText("1.8%");
    noTruncateAncestry(pct);
    // It is also shrink-0, which is what actually keeps it at max-content width while the
    // phrase absorbs the squeeze; a `truncate`-free ancestry alone would not.
    expect(pct.parentElement!.className).toMatch(/shrink-0/);
    // #1963 — …and the phrase it annotates absorbs that squeeze by WRAPPING, not by hiding
    // its tail. The invariant this test guards is that the shrink-0 occupants keep
    // max-content while the phrase yields; it never required the yielding to be a clip, and
    // a clip here ate the concept term (MeSH names put the disambiguating part last, so
    // "Leukemia-Lymphoma" clipped to "Leukemia" — a different disease). The phrase must
    // therefore be truncate-free too, and it is now the ONLY thing on the card that yields.
    const phrase = container.querySelector(".items-baseline")?.firstElementChild as HTMLElement;
    expect(phrase.textContent).toMatch(/2 of 114 publications/);
    expect(phrase.className).not.toMatch(/truncate/);
    noTruncateAncestry(phrase);
    // The pill is the other occupant of that slot and carries the same invariant. It is on
    // the MENTION row now — `subject-tagged` was cut for badging 100% of its class — so the
    // walk moves to the row that still has one.
    const mention = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "mention",
          text: "2 of 114 publications mention",
          term: "Leukemia",
          count: 2,
        }}
        pubCount={114}
        stacked
      />,
    );
    const pill = within(mention.container).getByText("keyword only");
    let node: HTMLElement | null = pill;
    while (node && node !== mention.container) {
      expect(node.className).not.toMatch(/truncate/);
      node = node.parentElement;
    }
    expect(pill.className).toMatch(/shrink-0/);
    // The via-line no longer truncates at all: the longer "matched on narrower term "
    // prefix — the one #1955 kept for the majority case, and the one VIA_BUDGET is measured
    // against — would have clipped the " and N related terms" tail, the one phrase saying
    // the list is partial, so the line WRAPS instead. It can afford to, being last on its
    // own line with nothing trailing it. Its ancestry must still be clean under either
    // prefix, or a clip would move up to a box that also holds the phrase.
    const via = screen.getByText("Leukemia, Lymphoid and 2 related terms");
    expect(via.className).not.toMatch(/truncate/);
    noTruncateAncestry(via.parentElement!);
    expect(via.nextElementSibling).toBeNull(); // nothing trails it on its line
  });

  it("the % is faint on a KEYWORD row, so the gutter stops implying one scale", () => {
    // The column invited a comparison it cannot support: a keyword row's 5.2% next to a
    // concept row's 4.7% says the keyword scholar is the better match while the mechanism
    // says the opposite. Same denominator, different KIND of evidence. Faint ink keeps the
    // number legible and comparable to other keyword rows without competing for the eye
    // with the curated ones.
    const mention = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "mention",
          text: "12 of 98 publications mention",
          term: "melanoma",
          count: 12,
        }}
        pubCount={98}
        stacked
      />,
    );
    expect(within(mention.container).getByText("12.2%").parentElement!.className).toContain(
      "text-[var(--evidence-faint)]",
    );

    const tagged = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "tagged",
          text: "12 of 98 publications tagged",
          term: "Melanoma",
          count: 12,
        }}
        pubCount={98}
        stacked
      />,
    );
    expect(within(tagged.container).getByText("12.2%").parentElement!.className).toContain(
      "text-[var(--evidence-body)]",
    );
  });

  it("a coverage that rounds below 0.1% displays '<0.1%' rather than a lying '0.0%'", () => {
    render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Imaging mass cytometry", tools: [], count: 1 }}
        pubCount={3000}
        stacked
      />,
    );
    // Uniform fold rule — the visible string is the number alone; " of output" moved into
    // the sr-only copy. A `/% of/` regex would still match that sr text, so this asserts the
    // VISIBLE cell exactly.
    expect(screen.getByText("<0.1%")).toBeTruthy();
    expect(screen.getByText("<0.1% of this scholar’s output")).toBeTruthy();
  });

  it("uniform fold rule — a keyword-only primary NOW SHOWS BOTH signals: the amber pill and the %", () => {
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
    expect(screen.getByText("Keyword")).toBeTruthy(); // the type word is retained
    // The old rule was PRECEDENCE: keyword-only beat low-coverage so the two never stacked,
    // because only one caveat string fitted the slot. There is no shared slot now — the pill
    // and the column are different boxes — so this lead (1/538 = 0.19%, AND a literal
    // mention) states both facts. Deliberately inverted, not deleted: the co-existence is
    // the behaviour change and it ships pinned.
    expect(pillsIn(container)).toEqual(["keyword only"]);
    expect(screen.getByText("0.2%")).toBeTruthy();
    // …and the retired prose is gone from both slots.
    expect(container.textContent).not.toMatch(/term match only/);
    // dim: the reason text drops to muted grey (the term span inherits it).
    expect(screen.getByText("crispr").className).toMatch(/text-\[var\(--evidence-body\)\]/);
  });

  it("uniform fold rule — a normal-coverage primary is NOT dimmed but STILL shows its %", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Flow cytometry", tools: [], count: 4 }}
        pubCount={98}
        stacked
      />,
    );
    // 4/98 = 4.1% ≥ 2% → not dim; the label stays near-black.
    expect(container.textContent).not.toMatch(/of output/);
    expect(screen.getByText("Flow cytometry").className).toMatch(
      /text-\[var\(--evidence-anchor\)\]/,
    );
    expect(screen.getByText("Flow cytometry").className).not.toMatch(
      /text-\[var\(--evidence-(faint|body)\)\]/,
    );
    // THE ALWAYS-ON PATH, and the most common one. The old assertions here were negative
    // (`not.toMatch(/of output/)`) and stayed green while the column rendered "4.1%"
    // untested — so the whole point of decoupling coverage from the threshold shipped
    // unpinned. The number renders, it is NOT the accent (that is reserved for the kind word
    // + matched count), and it carries the unit for a screen reader.
    const pct = screen.getByText("4.1%");
    expect(pct.getAttribute("aria-hidden")).toBe("true");
    expect(pct.parentElement!.className).toMatch(/tabular-nums/);
    expect(pct.parentElement!.className).toMatch(/text-\[var\(--evidence-body\)\]/);
    expect(pct.parentElement!.className).not.toMatch(/--evidence-accent/);
    expect(screen.getByText("4.1% of this scholar’s output")).toBeTruthy();
  });

  it("uniform fold rule — the %'s unit is sr-only and joins the disclosure button's accessible name", () => {
    // The MECHANISM, not just the text. A bare "8%" beside a match reason reads as a match
    // SCORE, so the unit has to be announced — and an sr-only sibling is the only one of the
    // three candidates that always is: `title` is not announced and needs a hover, and
    // `aria-label` on a bare span is name-from-author on `role=generic`, which AT may ignore.
    // Being sr-only (not merely present) is what keeps it from double-printing on screen;
    // being INSIDE the button is what puts it in the accessible name.
    render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Flow cytometry", tools: [], count: 4 }}
        pubCount={98}
        stacked
        canExpand
        onToggle={() => {}}
        panelId="p"
      />,
    );
    expect(screen.getByText("4.1% of this scholar’s output").className).toMatch(/sr-only/);
    expect(
      screen.getByRole("button", { name: /4\.1% of this scholar’s output/ }),
    ).toBeTruthy();
  });

  it("uniform fold rule — keyword-only dims a lead that is NOT low-coverage (the arm is independent)", () => {
    // Every other dim fixture in this file is BOTH a literal mention and under the 2%
    // threshold, so deleting the `keywordOnly ||` arm of the predicate left the suite green.
    // 12/98 = 12.2%, comfortably above the threshold: the only thing that can dim this lead
    // is its provenance.
    const { container } = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "mention",
          text: "12 of 98 publications mention",
          term: "crispr",
          count: 12,
        }}
        pubCount={98}
        stacked
      />,
    );
    expect(screen.getByText("12.2%")).toBeTruthy(); // …and it is NOT the low-coverage arm
    expect(screen.getByText("Keyword").className).toMatch(/text-\[var\(--evidence-faint\)\]/);
    expect(screen.getByText("crispr").className).toMatch(/text-\[var\(--evidence-body\)\]/);
    expect(container.innerHTML).not.toContain("--evidence-accent");
  });

  it("uniform fold rule — the % does NOT dim, so the stat that justifies the dimming survives", () => {
    // #1907's lesson, as a token assertion: a thin lead fainting its phrase must not faint
    // the number that explains why. This is a one-token change away from regressing.
    render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Mass spectrometry", tools: [], count: 1 }}
        pubCount={538}
        stacked
      />,
    );
    expect(screen.getByText("0.2%").parentElement!.className).toMatch(
      /text-\[var\(--evidence-body\)\]/,
    );
    expect(screen.getByText("0.2%").parentElement!.className).not.toMatch(/--evidence-faint/);
  });

  it("uniform fold rule — clinical has NO % column (no pub denominator) but DOES get the credential pill", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "clinical", specialty: "Cardiology", boardCertified: true }}
        pubCount={44}
        stacked
      />,
    );
    expect(container.querySelector(".tabular-nums")).toBeNull();
    expect(pillsIn(container)).toEqual(["credential"]);
    // The prose stays: it names the specialty the certification is IN, which "credential"
    // does not say.
    expect(container.textContent).toMatch(/Board certified in Cardiology/);
  });

  it("uniform fold rule — a NOT board-certified clinical lead gets no pill", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "clinical", specialty: "Cardiology", boardCertified: false }}
        pubCount={44}
        stacked
      />,
    );
    expect(pillsIn(container)).toEqual([]);
  });

  it("uniform fold rule — ONLY the exception strength is badged; tagged and concept get none", () => {
    // Keyed to PROVENANCE, and only where the badge says something the row's own kind column
    // does not. `tagged` is the NORM on this row: it appeared on 100% of its class and
    // restated the `Concept` label beside it, so it carries no bits and is cut. `concept`
    // (a MeSH-expansion text variant) gets none either — it is not a subject tag and not a
    // bare keyword, so claiming either would be false. Only `mention` earns one.
    const tagged = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "tagged",
          text: "12 of 98 publications tagged",
          term: "Melanoma",
          count: 12,
        }}
        pubCount={98}
        stacked
      />,
    );
    expect(pillsIn(tagged.container)).toEqual([]);

    const mention = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "mention",
          text: "12 of 98 publications mention",
          term: "melanoma",
          count: 12,
        }}
        pubCount={98}
        stacked
      />,
    );
    expect(pillsIn(mention.container)).toEqual(["keyword only"]);

    const concept = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "concept",
          text: "12 of 98 publications tagged",
          term: "Melanoma",
          count: 12,
        }}
        pubCount={98}
        stacked
      />,
    );
    expect(pillsIn(concept.container)).toEqual([]);
  });

  it("uniform fold rule — the pill text uses the AA-passing green token, never the trap", () => {
    // `--apollo-green` (#2e7d5b) is the token literally named "semantic green" and the
    // obvious pick for green pill text. It scores 4.39:1 on `--apollo-green-tint` and FAILS
    // AA at 11px. Only `--apollo-green-foreground` (6.92:1) may back this word.
    // `credential` is the green pill now — `subject-tagged` was cut for badging the norm,
    // and green survives on the one badge that states something its label does not.
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "clinical", specialty: "Vascular Neurology", boardCertified: true }}
        pubCount={98}
        stacked
      />,
    );
    const pill = screen.getByText("credential");
    expect(pill.className).toContain("text-[var(--apollo-green-foreground)]");
    expect(pill.className).not.toContain("text-[var(--apollo-green)]");
    // the border is load-bearing (ΔE 5.01 fill-vs-row-hover); it is not decoration.
    expect(pill.className).toMatch(/border-\[var\(--apollo-green-tint-border\)\]/);
    // and a capsule would read as the retired #1913 category dot.
    expect(container.querySelectorAll("span.rounded-full").length).toBe(0);
  });

  it("the single-evidence path (stacked omitted) gets NO % column and NO dim, even at low coverage", () => {
    // Same 1/538 = 0.19% lead as the first test, but without `stacked` → the new signals are
    // gated off so the single-evidence render stays visually frozen (matches C/D).
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Mass spectrometry", tools: [], count: 1 }}
        pubCount={538}
      />,
    );
    expect(container.textContent).not.toMatch(/of output/);
    expect(screen.queryByText("0.2%")).toBeNull();
    expect(container.querySelector(".tabular-nums")).toBeNull();
    expect(screen.getByText("Mass spectrometry").className).not.toMatch(
      /text-\[var\(--evidence-faint\)\]/,
    );
  });

  it("the single-evidence path gets NO publications pill either (the frozen surface)", () => {
    const { container } = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "tagged",
          text: "12 of 98 publications tagged",
          term: "Melanoma",
          count: 12,
        }}
        pubCount={98}
      />,
    );
    expect(pillsIn(container)).toEqual([]);
  });

  it("the single-evidence path gets NO credential pill either — the SAME rule as the other two", () => {
    // `selectEvidence` DOES emit `clinical.boardCertified` on this path (lib/api/
    // result-evidence.ts), so nothing structural withholds the pill — only the `stacked`
    // gate does. Without it the frozen surface grew a green pill nobody had pinned.
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "clinical", specialty: "Cardiology", boardCertified: true }}
        pubCount={44}
      />,
    );
    expect(pillsIn(container)).toEqual([]);
    // The fact survives without it — which is why gating costs nothing here.
    expect(container.textContent).toMatch(/Board certified in Cardiology/);
  });

  it("the 'via' line IS allowed on the single-evidence path — it is a MOVE, not an addition", () => {
    // The deliberate exception to the rule above, and the reason it is not inconsistency:
    // every gated element is NEW, while this line is where the pre-existing "(matched X · Y)"
    // parenthetical went. Gating it would DELETE a datum this surface already showed rather
    // than withhold one it never had, and would leave the #1907 clip bug alive on one
    // surface while fixing it on the other.
    const { container } = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "tagged",
          text: "152 of 250 publications tagged",
          term: "Leukemia",
          count: 152,
          descendantTerms: ["Leukemia, Hairy Cell", "Leukemia, Myeloid"],
        }}
        pubCount={250}
      />,
    );
    const via = screen.getByText("Leukemia, Hairy Cell · Leukemia, Myeloid");
    expect(via.textContent).toBe(
      "matched on narrower term Leukemia, Hairy Cell · Leukemia, Myeloid",
    );
    // …and it is the line, not the retired parenthetical: no "(matched" anywhere.
    expect(container.textContent).not.toMatch(/\(matched/);
  });
});

/**
 * NARROW VIEWPORTS — jsdom computes no layout and evaluates no media query, so these pin
 * the CLASS CONTRACT that the browser measurements rest on. Geometry was verified
 * separately in Chromium against a box-model repro of these exact strings: before the
 * responsive variants the primary lead's phrase measured 0px wide at both 390px and 768px
 * viewports, with the pill overlapping the % cell by 93.5px and the row overrunning the
 * card's stats column; after them the phrase measures 148px at 390 and 254px at 768, and
 * the `lg` render is byte-identical to the approved desktop one.
 *
 * Each assertion below is the single class a mutation would have to remove to put that 0px
 * back, so they are written as exact-token matches rather than substring checks.
 */
describe("<ResultEvidence> — the primary lead degrades instead of collapsing on narrow viewports", () => {
  const hasToken = (el: Element, token: string) =>
    el.className.split(/\s+/).includes(token);

  const renderTagged = (extra?: Partial<Record<string, unknown>>) =>
    render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "tagged",
          text: "12 of 98 publications tagged",
          term: "Melanoma",
          count: 12,
        }}
        pubCount={98}
        stacked
        {...extra}
      />,
    );

  it("the kind column is full-width below `lg` and only then the fixed 124px column", () => {
    // 124px of fixed chrome against a 191px card middle column is what left the phrase 0px
    // wide. Below `lg` the word takes a line of its own instead of a column.
    const { container } = renderTagged();
    const kind = screen.getByText("Concept");
    expect(hasToken(kind, "w-full")).toBe(true);
    expect(hasToken(kind, "lg:w-[124px]")).toBe(true);
    // …and NOT both widths unprefixed: two same-property utilities resolve by
    // generated-stylesheet order in Tailwind v4, so a bare `w-[124px]` here would make the
    // winner unreadable off the JSX.
    expect(hasToken(kind, "w-[124px]")).toBe(false);
    // The full-width word only stacks if the row it sits in actually wraps.
    const row = container.firstElementChild!;
    expect(hasToken(row, "flex-wrap")).toBe(true);
    expect(hasToken(row, "lg:flex-nowrap")).toBe(true);
    expect(hasToken(row, "flex-nowrap")).toBe(false);
  });

  it("the expandable row wraps too — the disclosure button IS the flex row there", () => {
    // The wrap has to reach `DisclosureRow`'s button, not just the non-expandable div; the
    // expandable lead is the common case and it is the tighter of the two (chevron + gap).
    renderTagged({ canExpand: true, onToggle: () => {}, panelId: "p" });
    const button = screen.getByRole("button");
    expect(hasToken(button, "flex-wrap")).toBe(true);
    expect(hasToken(button, "lg:flex-nowrap")).toBe(true);
  });

  it("the % column and the pill are dropped below `lg`, where the row cannot hold them", () => {
    renderTagged();
    const pct = screen.getByText("12.2%").parentElement!;
    expect(hasToken(pct, "hidden")).toBe(true);
    expect(hasToken(pct, "lg:block")).toBe(true);
    // The pill rides the MENTION row now (`subject-tagged` was cut), and takes the same
    // breakpoint: it is the other shrink-0 occupant of the slot the phrase pays for.
    const { container } = render(
      <ResultEvidence
        evidence={{
          kind: "publications",
          strength: "mention",
          text: "12 of 98 publications mention",
          term: "melanoma",
          count: 12,
        }}
        pubCount={98}
        stacked
      />,
    );
    const pill = within(container).getByText("keyword only");
    expect(hasToken(pill, "hidden")).toBe(true);
    expect(hasToken(pill, "lg:inline-flex")).toBe(true);
    expect(hasToken(pill, "inline-flex")).toBe(false);
  });

  it("nothing narrow-only is lost: the phrase states the ratio the hidden % rounds", () => {
    // The licence for hiding the column. `coverage` and the "N of M" phrase are computed
    // from the same pair, so wherever the % renders the fraction is already on screen in
    // full — 12 of 98 IS the 12.2%. If a future lead ever set `coverage` without a count in
    // the phrase, this fails and the hiding stops being free.
    const { container } = renderTagged();
    expect(screen.getByText("12.2%")).toBeTruthy();
    expect(container.textContent).toMatch(/12 of 98 publications tagged/);
    // Same for the method/topic leads, which build the phrase through `CountFirst`.
    const method = render(
      <ResultEvidence
        evidence={{ kind: "method", family: "Flow cytometry", tools: [], count: 4 }}
        pubCount={98}
        stacked
      />,
    );
    expect(screen.getByText("4.1%")).toBeTruthy();
    expect(method.container.textContent).toMatch(/4 of 98 publications used/);
  });

  it("the lesser row drops its pill at a NARROWER breakpoint — it loses less to it", () => {
    // Not a copy of the primary rule: this row is one truncating line, and the pill only
    // costs it anything below ~480px (measured: 73 of its 81px at a 320px viewport). Hiding
    // it all the way to `lg` would drop it across a band where it is free.
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "clinical", specialty: "Cardiology", boardCertified: true }}
        pubCount={44}
        stacked
        tier="lesser"
      />,
    );
    expect(pillsIn(container)).toEqual(["credential"]);
    const pill = screen.getByText("credential");
    expect(hasToken(pill, "hidden")).toBe(true);
    expect(hasToken(pill, "sm:inline-flex")).toBe(true);
    expect(hasToken(pill, "lg:inline-flex")).toBe(false);
  });

  it("the % column's right pad is 43px and `lg`-only — the button path is NARROWER, not wider", () => {
    // `DisclosureRow` is `-mx-2 … w-full … px-2`. A block-level box with `width: 100%` and
    // two negative inline margins is over-constrained, so CSS 2.1 §10.3.3 drops the
    // margin-RIGHT: the button ends 8px SHORT of this wrapper, not past it. Measured at
    // 1024px, an expandable row's % cell sits 43px in from the middle column's right edge
    // (16 dropped margin + 20 chevron + 7 gap); the old `pr-[27px]` counted only the last
    // two and left the two rows 16px out of line — the opposite of what the pad is for.
    const { container } = renderTagged();
    const row = container.firstElementChild!;
    expect(hasToken(row, "lg:pr-[43px]")).toBe(true);
    expect(hasToken(row, "pr-[27px]")).toBe(false);
    // Below `lg` there is no % cell to align, so there is nothing to pad for.
    expect(row.className).not.toMatch(/(^|\s)pr-\[/);
  });

  it("no % cell ⇒ no pad at all: the row is not reserving space for a column it lacks", () => {
    // Clinical has no pub denominator, so no % column — and an unconditional pad would
    // shove its (chevron-less) row 43px left of every other one for nothing.
    const { container } = render(
      <ResultEvidence
        evidence={{ kind: "clinical", specialty: "Cardiology", boardCertified: true }}
        pubCount={44}
        stacked
      />,
    );
    expect(container.querySelector(".tabular-nums")).toBeNull();
    expect(container.firstElementChild!.className).not.toMatch(/pr-\[43px\]/);
  });
});
