import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ScholarFamilyView } from "@/lib/api/profile";

// The redesigned MethodsSection (Surface A, #1167) consumes usePublicationModal()
// unconditionally — the profile render path is always under
// <PublicationModalProvider>. Mock the module so the hook resolves to a spy
// `open` (no real provider / no modal fetch), and assert the source action calls
// open(pmid).
const openMock = vi.fn();
vi.mock("@/components/publication/publication-modal", () => ({
  usePublicationModal: () => ({ open: openMock, close: vi.fn(), state: null }),
  PublicationModalProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Imported AFTER the mock so the component picks up the mocked hook.
import { MethodsSection } from "@/components/profile/methods-section";

beforeEach(() => {
  openMock.mockClear();
});

function makeFamilies(n: number): ScholarFamilyView[] {
  return Array.from({ length: n }, (_, i) => ({
    familyId: `fam_${i + 1}`,
    familyLabel: `Family ${i + 1}`,
    supercategory: "imaging_microscopy",
    pubCount: 100 - i,
    exemplarTools: [`Tool ${i + 1}A`, `Tool ${i + 1}B`],
    pmids: [`${i + 1}001`, `${i + 1}002`],
    definition: null,
    definitionSource: null,
    exemplarContexts: {},
    exemplarContextPmids: {},
  }));
}

// The #1167 redesign rides PROFILE_FACET_REDESIGN (`facetRedesignEnabled`). The
// flag-off path is the legacy renderer (covered in its own describe block below).
// filterEnabled drives the checkbox-as-filter; onFamilyToggle is the toggle
// callback.
const REDESIGN = { facetRedesignEnabled: true } as const;
const filterProps = {
  facetRedesignEnabled: true,
  filterEnabled: true,
  onFamilyToggle: () => {},
} as const;

describe("MethodsSection", () => {
  it("renders family labels, dot-joined exemplar tools, and counts", () => {
    render(<MethodsSection families={makeFamilies(2)} />);
    expect(screen.getByText("Family 1")).toBeTruthy();
    expect(screen.getByText("Tool 1A · Tool 1B")).toBeTruthy(); // exemplars joined with " · "
    expect(screen.getByText("100")).toBeTruthy();
    expect(screen.getByText("99")).toBeTruthy();
  });

  it("omits the exemplar sub-line when a family has no exemplar tools", () => {
    render(
      <MethodsSection
        families={[
          {
            familyId: "fam_1",
            familyLabel: "Solo family",
            supercategory: "s",
            pubCount: 5,
            exemplarTools: [],
            pmids: ["1", "2", "3", "4", "5"],
            definition: null,
            definitionSource: null,
            exemplarContexts: {},
            exemplarContextPmids: {},
          },
        ]}
      />,
    );
    expect(screen.getByText("Solo family")).toBeTruthy();
    // The mono exemplar line (rendered INSIDE the row) uses " · " joins; with no
    // exemplar tools none should be present. Scope to the row so the section's
    // intro copy — which legitimately carries a "·" — isn't matched.
    const row = screen.getByText("Solo family").closest("li") as HTMLElement;
    expect(within(row).queryByText(/·/)).toBeNull();
  });

  it("renders nothing when there are no families", () => {
    const { container } = render(<MethodsSection families={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("caps unselected families at 6 and shows a '+ N more' inline expand", () => {
    render(<MethodsSection families={makeFamilies(11)} selectedFamilyIds={[]} {...filterProps} />);
    expect(screen.getByText("Family 6")).toBeTruthy();
    expect(screen.queryByText("Family 7")).toBeNull();
    expect(screen.getByRole("button", { name: /\+ 5 more method families/ })).toBeTruthy();
  });

  it("uses the singular 'family' when exactly one is hidden", () => {
    render(<MethodsSection families={makeFamilies(7)} selectedFamilyIds={[]} {...filterProps} />);
    expect(screen.getByRole("button", { name: /\+ 1 more method family/ })).toBeTruthy();
  });

  it("renders the A2 disambiguating caption (clauses gated on live affordances)", () => {
    render(
      <MethodsSection
        families={[
          {
            familyId: "fam_1",
            familyLabel: "Chest radiograph models",
            supercategory: "imaging_microscopy",
            pubCount: 12,
            exemplarTools: ["CheXpert"],
            pmids: ["1"],
            definition: null,
            definitionSource: null,
            exemplarContexts: { CheXpert: "CheXpert labels chest radiographs" },
            exemplarContextPmids: {},
          },
        ]}
        filterEnabled
        onFamilyToggle={() => {}}
        pagesEnabled
        {...REDESIGN}
      />,
    );
    expect(
      screen.getByText(
        /Tick the box to filter this profile in place\. Underlined terms have a usage example/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/The pill opens that method's publications\./)).toBeTruthy();
  });

  // HIGH#2 — when the filter is NOT wired (METHODS_LENS_FAMILY_FILTER off), the
  // "Tick the box" clause and the row toggle button must NOT render (no inert
  // affordance / false instruction).
  it("omits the 'Tick the box' clause and the row toggle when the filter is off", () => {
    render(<MethodsSection families={makeFamilies(2)} {...REDESIGN} />);
    expect(screen.queryByText(/Tick the box to filter/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Family 1" })).toBeNull();
    // The checkbox glyph is suppressed too (display-only lens): the row's first
    // element child is the content div, not a leading checkbox <svg>.
    const row = screen.getByText("Family 1").closest("li") as HTMLElement;
    expect(row.firstElementChild?.tagName).not.toBe("svg");
  });
});

describe("MethodsSection — #801 sensitive reveal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not fetch (or mark anything) when the sensitivity gate is off", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MethodsSection families={makeFamilies(2)} scholarCwid="aog" sensitiveGateActive={false} />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Hidden from the public profile")).toBeNull();
  });

  it("reveals gated families with the eye-off marker when the route returns them", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        families: [
          {
            familyId: "fam_sensitive",
            familyLabel: "Genetically engineered mouse models",
            supercategory: "animal_cell_models",
            pubCount: 50,
            exemplarTools: ["Cre-lox"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MethodsSection families={makeFamilies(2)} scholarCwid="aog" sensitiveGateActive />);

    // The public families render immediately (unmarked)...
    expect(screen.getByText("Family 1")).toBeTruthy();
    // ...and the gated family + its "hidden from public" marker appear after the
    // owner/admin reveal fetch resolves.
    await waitFor(() =>
      expect(screen.getByText("Genetically engineered mouse models")).toBeTruthy(),
    );
    expect(screen.getByLabelText("Hidden from the public profile")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/profile/aog/sensitive-families"),
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("does not mark public families (no marker when the reveal returns none)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ families: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<MethodsSection families={makeFamilies(2)} scholarCwid="aog" sensitiveGateActive />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByLabelText("Hidden from the public profile")).toBeNull();
  });
});

describe("MethodsSection — A4 checkbox filter vs count+arrow pill", () => {
  it("renders the row as a checkbox toggle that fires onFamilyToggle(familyId)", () => {
    const onFamilyToggle = vi.fn();
    render(
      <MethodsSection
        families={makeFamilies(2)}
        {...REDESIGN}
        filterEnabled
        selectedFamilyIds={[]}
        onFamilyToggle={onFamilyToggle}
      />,
    );
    const row = screen.getByText("Family 1").closest("li") as HTMLElement;
    // The whole-row toggle is a button labelled with the family name; clicking it
    // filters in place (it does NOT navigate).
    const toggle = within(row).getByRole("button", { name: "Family 1" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(onFamilyToggle).toHaveBeenCalledWith("fam_1");
  });

  it("reflects the selected family with aria-pressed and a SquareCheck + remove control", () => {
    render(
      <MethodsSection
        families={makeFamilies(2)}
        {...REDESIGN}
        filterEnabled
        selectedFamilyIds={["fam_2"]}
        onFamilyToggle={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Family 2" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Family 1" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    const selectedRow = screen.getByText("Family 2").closest("li") as HTMLElement;
    expect(selectedRow.className).toContain("bg-[var(--color-facet-method-fill)]");
    expect(within(selectedRow).getByRole("button", { name: /Remove Family 2 filter/ })).toBeTruthy();
  });

  it("renders the count+arrow PILL as a navigation LINK (distinct from the filter toggle)", () => {
    render(
      <MethodsSection
        families={makeFamilies(2)}
        {...REDESIGN}
        filterEnabled
        selectedFamilyIds={[]}
        onFamilyToggle={() => {}}
        pagesEnabled
      />,
    );
    const row = screen.getByText("Family 1").closest("li") as HTMLElement;
    // The pill is a navigating link to the family's publications page...
    const pill = within(row).getByRole("link", { name: /Family 1/ });
    expect(pill.getAttribute("href")).toContain("/methods/");
    expect(within(pill).getByText("100")).toBeTruthy();
    // ...separate from the filter toggle button on the same row.
    expect(within(row).getByRole("button", { name: "Family 1" })).toBeTruthy();
  });

  it("renders a non-navigating count chip when METHODS_LENS_PAGES is off", () => {
    render(
      <MethodsSection
        families={makeFamilies(2)}
        {...REDESIGN}
        filterEnabled
        selectedFamilyIds={[]}
        onFamilyToggle={() => {}}
      />,
    );
    const row = screen.getByText("Family 1").closest("li") as HTMLElement;
    // No navigate link when pages are off — the count is a plain chip.
    expect(within(row).queryByRole("link")).toBeNull();
    expect(within(row).getByText("100")).toBeTruthy();
  });

  it("renders contextual '{in} of {total}' counts from familyCounts", () => {
    const familyCounts = new Map<string, number>([
      ["fam_1", 6],
      ["fam_2", 5],
    ]);
    render(
      <MethodsSection
        families={makeFamilies(2)}
        {...REDESIGN}
        filterEnabled
        selectedFamilyIds={["fam_1"]}
        onFamilyToggle={() => {}}
        familyCounts={familyCounts}
      />,
    );
    expect(screen.getByText("Counts shown within current filter")).toBeTruthy();
    const selected = screen.getByText("Family 1").closest("li") as HTMLElement;
    expect(within(selected).getByText("6")).toBeTruthy();
    expect(within(selected).getByText(/of 100/)).toBeTruthy();
    const unselected = screen.getByText("Family 2").closest("li") as HTMLElement;
    expect(within(unselected).getByText("5")).toBeTruthy();
    expect(within(unselected).getByText(/of 99/)).toBeTruthy();
  });

  it("dims a zero-count row (familyCounts present and the family count is 0)", () => {
    const familyCounts = new Map<string, number>([
      ["fam_1", 6],
      ["fam_2", 0],
    ]);
    render(
      <MethodsSection
        families={makeFamilies(2)}
        {...REDESIGN}
        filterEnabled
        selectedFamilyIds={["fam_1"]}
        onFamilyToggle={() => {}}
        familyCounts={familyCounts}
      />,
    );
    const zeroRow = screen.getByText("Family 2").closest("li") as HTMLElement;
    // The row's content + count carry the ~45% dim.
    expect(zeroRow.innerHTML).toContain("opacity-45");
    expect(within(zeroRow).getByText(/of 99/)).toBeTruthy();
  });
});

describe("MethodsSection — v2 budget / selected-zero / animation (#841)", () => {
  const redesignProps = {
    facetRedesignEnabled: true,
    filterEnabled: true,
    onFamilyToggle: () => {},
  };

  function rowsUl() {
    return screen.getByText("Family 1").closest("ul") as HTMLElement;
  }

  // #1 — cap UNSELECTED rows at 6 in the resting panel.
  it("#1 caps unselected rows at 6 in the resting panel", () => {
    render(<MethodsSection families={makeFamilies(11)} selectedFamilyIds={[]} {...redesignProps} />);
    for (let i = 1; i <= 6; i++) expect(screen.getByText(`Family ${i}`)).toBeTruthy();
    expect(screen.queryByText("Family 7")).toBeNull();
    expect(screen.getByRole("button", { name: /\+ 5 more method families/ })).toBeTruthy();
  });

  // #2 — budget unselected INDEPENDENTLY of selected (4 selected => 4 + 6 = 10),
  //      and selected families are never budgeted out even at low rank.
  it("#2 budgets unselected independently of selected (low-rank selected stay pinned)", () => {
    render(
      <MethodsSection
        families={makeFamilies(20)}
        selectedFamilyIds={["fam_17", "fam_18", "fam_19", "fam_20"]}
        {...redesignProps}
      />,
    );
    // The 4 low-rank selected families render despite their rank...
    for (const i of [17, 18, 19, 20]) expect(screen.getByText(`Family ${i}`)).toBeTruthy();
    // ...plus the top 6 unselected.
    for (let i = 1; i <= 6; i++) expect(screen.getByText(`Family ${i}`)).toBeTruthy();
    expect(screen.queryByText("Family 7")).toBeNull();
    expect(rowsUl().querySelectorAll(":scope > li").length).toBe(10);
    // N counts unselected-AND-hidden only: 20 - 4 selected - 6 shown = 10.
    expect(screen.getByRole("button", { name: /\+ 10 more method families/ })).toBeTruthy();
  });

  // #3/#4 — "+N more" EXPANDS INLINE (a button, never a navigating link), and
  //         "Show fewer" appears once expanded.
  it("#3 the +N more control expands inline and never navigates", () => {
    render(<MethodsSection families={makeFamilies(20)} selectedFamilyIds={[]} {...redesignProps} />);
    expect(screen.queryByRole("link", { name: /more method families/ })).toBeNull();
    const more = screen.getByRole("button", { name: /\+ 14 more method families/ });
    fireEvent.click(more);
    // 6 + UNSELECTED_STEP(10) = 16 visible; 20 - 16 = 4 hidden.
    expect(screen.getByText("Family 16")).toBeTruthy();
    expect(screen.getByRole("button", { name: /\+ 4 more method families/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show fewer" })).toBeTruthy();
  });

  it("#5 introduces no nested scroll region on the rows", () => {
    render(<MethodsSection families={makeFamilies(11)} selectedFamilyIds={[]} {...redesignProps} />);
    expect(rowsUl().className).not.toMatch(/overflow-y-auto|overflow-scroll|max-h-/);
  });

  // #11 — a singleton (pubCount: 1) family must still render (no min-2 floor).
  it("#11 renders a single-publication family (no display floor)", () => {
    render(
      <MethodsSection
        families={[
          {
            familyId: "fam_solo",
            familyLabel: "Single-pub method",
            supercategory: "imaging_microscopy",
            pubCount: 1,
            exemplarTools: ["Tool X"],
            pmids: ["9001"],
            definition: null,
            definitionSource: null,
            exemplarContexts: {},
            exemplarContextPmids: {},
          },
        ]}
        selectedFamilyIds={[]}
        {...redesignProps}
      />,
    );
    expect(screen.getByText("Single-pub method")).toBeTruthy();
  });

  // #7 — a SELECTED zero-count row is a deliberate, non-dimmed state, distinct
  //      from the dimmed (#14) UNSELECTED zero-count row.
  it("#7 selected-zero is a deliberate non-dimmed state, distinct from the #14 dim-zero", () => {
    render(
      <MethodsSection
        families={makeFamilies(2)}
        selectedFamilyIds={["fam_1"]}
        familyCounts={
          new Map<string, number>([
            ["fam_1", 0],
            ["fam_2", 0],
          ])
        }
        {...redesignProps}
      />,
    );
    // fam_1: selected + 0 → deliberate selected-zero (filled, ringed, full opacity).
    const selZero = screen.getByText("Family 1").closest("li") as HTMLElement;
    expect(selZero.getAttribute("data-selected-zero")).toBe("true");
    expect(selZero.className).toContain("bg-[var(--color-facet-method-fill)]");
    expect(selZero.className).toContain("ring-[var(--color-facet-method-border)]");
    expect(selZero.innerHTML).not.toContain("opacity-45");
    expect(within(selZero).getByRole("button", { name: /Remove Family 1 filter/ })).toBeTruthy();
    expect(
      within(selZero).getByLabelText(/No publications match Family 1 under the current filters/),
    ).toBeTruthy();
    // fam_2: unselected + 0 → the dimmed inert state (#14), NOT selected-zero.
    const dimZero = screen.getByText("Family 2").closest("li") as HTMLElement;
    expect(dimZero.getAttribute("data-selected-zero")).toBeNull();
    expect(dimZero.innerHTML).toContain("opacity-45");
  });

  // #17 — rows carry the chip-fill transition.
  it("#17 rows carry facet-chip-transition", () => {
    render(
      <MethodsSection families={makeFamilies(2)} selectedFamilyIds={["fam_1"]} {...redesignProps} />,
    );
    const sel = screen.getByText("Family 1").closest("li") as HTMLElement;
    const unsel = screen.getByText("Family 2").closest("li") as HTMLElement;
    expect(sel.className).toContain("facet-chip-transition");
    expect(unsel.className).toContain("facet-chip-transition");
  });
});

// #879 — the generated family definition surfaces as a hover (i) trigger next to
// the family label. The server data layer nulls `definition` unless the flag is on,
// so the component simply renders the trigger iff a definition is present.
describe("MethodsSection — #879 family definition hover", () => {
  function withDefinition(def: string | null, source: string | null): ScholarFamilyView[] {
    return [
      {
        familyId: "fam_1",
        familyLabel: "CRISPR screens",
        supercategory: "genome_engineering",
        pubCount: 8,
        exemplarTools: ["GeCKO"],
        pmids: ["1", "2"],
        definition: def,
        definitionSource: source,
        exemplarContexts: {},
        exemplarContextPmids: {},
      },
    ];
  }

  it("renders an (i) hover trigger labelled 'About <family>' when a definition is present", () => {
    render(<MethodsSection families={withDefinition("Pooled loss-of-function screens.", "generated")} />);
    expect(screen.getByRole("button", { name: "About CRISPR screens" })).toBeTruthy();
  });

  it("renders NO definition trigger when the definition is null (flag off / not populated)", () => {
    render(<MethodsSection families={withDefinition(null, null)} />);
    expect(screen.queryByRole("button", { name: "About CRISPR screens" })).toBeNull();
  });

  // radix renders TooltipContent twice (visible + a visually-hidden a11y mirror),
  // so assert on getAllByText length rather than a single match.
  it("shows the 'AI-generated definition' disclaimer when definitionSource === 'generated'", async () => {
    render(<MethodsSection families={withDefinition("Pooled CRISPR screens.", "generated")} />);
    fireEvent.focus(screen.getByRole("button", { name: "About CRISPR screens" }));
    await waitFor(() =>
      expect(screen.getAllByText("AI-generated definition").length).toBeGreaterThan(0),
    );
  });

  it("omits the disclaimer when definitionSource is null (non-generated gloss)", async () => {
    render(<MethodsSection families={withDefinition("A curated gloss.", null)} />);
    fireEvent.focus(screen.getByRole("button", { name: "About CRISPR screens" }));
    // The tooltip opens (definition appears) but carries NO AI disclaimer.
    await waitFor(() => expect(screen.getAllByText("A curated gloss.").length).toBeGreaterThan(0));
    expect(screen.queryAllByText("AI-generated definition")).toHaveLength(0);
  });
});

// #1167 / A1 — the persistent provenance rail. Hovering/focusing an evidenced
// tool sets the rail item (eyebrow / term / verbatim sentence); the host retains
// the last-hovered item (never blanks on mouse-leave). The source action opens
// the in-app publication modal (Q-7) when a per-tool source pmid is carried.
describe("MethodsSection — Surface A provenance rail (#1167)", () => {
  function withContext(
    contexts: Record<string, string>,
    pmids: Record<string, string> = {},
  ): ScholarFamilyView[] {
    return [
      {
        familyId: "fam_1",
        familyLabel: "Chest radiograph models",
        supercategory: "imaging_microscopy",
        pubCount: 12,
        exemplarTools: ["CheXpert", "MIMIC-CXR"],
        pmids: ["1", "2"],
        definition: null,
        definitionSource: null,
        exemplarContexts: contexts,
        exemplarContextPmids: pmids,
      },
    ];
  }

  // The verbatim usage sentence carries the tool name (as real `usage_sentence`
  // data does), so the rail can highlight the matched term in place (the #1119
  // interim term-match; replaced by §7 offsets once #1166 emits them).
  const SNIPPET = "CheXpert labels chest radiographs across 14 observations";

  it("evidenced tools get a focusable dotted-underline trigger; un-evidenced tools are plain text", () => {
    render(<MethodsSection families={withContext({ CheXpert: SNIPPET })} {...REDESIGN} />);
    // CheXpert has a snippet → it is an interactive control...
    expect(screen.getByRole("button", { name: /Usage example for CheXpert/ })).toBeTruthy();
    // MIMIC-CXR has no snippet → no trigger, plain text only.
    expect(screen.queryByRole("button", { name: /Usage example for MIMIC-CXR/ })).toBeNull();
  });

  it("renders the plain dotted join when no tool has a snippet (data flag off)", () => {
    render(<MethodsSection families={withContext({})} {...REDESIGN} />);
    expect(screen.getByText("CheXpert · MIMIC-CXR")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Usage example for/ })).toBeNull();
  });

  it("hovering an evidenced tool populates the rail (eyebrow / term / verbatim sentence, term marked)", () => {
    const { container } = render(<MethodsSection families={withContext({ CheXpert: SNIPPET })} {...REDESIGN} />);
    const rail = container.querySelector('[aria-live="polite"]') as HTMLElement;
    // Before any interaction the rail shows a placeholder, not the snippet.
    expect(rail.textContent).toMatch(/Hover an underlined tool/);

    fireEvent.mouseEnter(screen.getByRole("button", { name: /Usage example for CheXpert/ }));

    // Surface A eyebrow (NOT the modal / Surface B wording).
    expect(within(rail).getByText("Verbatim, from this scholar's papers")).toBeTruthy();
    // The term heads the rail and is marked in the sentence.
    expect(within(rail).getAllByText("CheXpert").length).toBeGreaterThan(0);
    expect(rail.textContent).toContain(SNIPPET);
    expect(rail.querySelector("mark")?.textContent).toBe("CheXpert");
  });

  it("focusing an evidenced tool updates the rail identically (keyboard parity)", () => {
    const { container } = render(<MethodsSection families={withContext({ CheXpert: SNIPPET })} {...REDESIGN} />);
    const rail = container.querySelector('[aria-live="polite"]') as HTMLElement;
    fireEvent.focus(screen.getByRole("button", { name: /Usage example for CheXpert/ }));
    expect(within(rail).getByText("Verbatim, from this scholar's papers")).toBeTruthy();
    expect(rail.textContent).toContain(SNIPPET);
  });

  it("retains the last-hovered item (never blanks on mouse-leave)", () => {
    const { container } = render(<MethodsSection families={withContext({ CheXpert: SNIPPET })} {...REDESIGN} />);
    const rail = container.querySelector('[aria-live="polite"]') as HTMLElement;
    const trigger = screen.getByRole("button", { name: /Usage example for CheXpert/ });
    fireEvent.mouseEnter(trigger);
    expect(rail.textContent).toContain(SNIPPET);
    // Leaving the tool must NOT blank the rail — it retains the last item.
    fireEvent.mouseLeave(trigger);
    expect(rail.textContent).toContain(SNIPPET);
    expect(rail.textContent).not.toMatch(/Hover an underlined tool/);
  });

  it("swaps the rail to the newly-hovered tool's item", () => {
    const { container } = render(
      <MethodsSection
        families={withContext({
          CheXpert: SNIPPET,
          "MIMIC-CXR": "a dataset of 377,110 chest radiographs",
        })}
        {...REDESIGN}
      />,
    );
    const rail = container.querySelector('[aria-live="polite"]') as HTMLElement;
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Usage example for CheXpert/ }));
    expect(rail.textContent).toContain(SNIPPET);
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Usage example for MIMIC-CXR/ }));
    expect(rail.textContent).toContain("a dataset of 377,110 chest radiographs");
    expect(rail.textContent).not.toContain(SNIPPET);
  });

  it("renders a source control when a per-tool source pmid is carried (#1158)", () => {
    const { container } = render(
      <MethodsSection
        families={withContext({ CheXpert: SNIPPET }, { CheXpert: "33144353" })}
        {...REDESIGN}
      />,
    );
    const rail = container.querySelector('[aria-live="polite"]') as HTMLElement;
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Usage example for CheXpert/ }));
    expect(within(rail).getByRole("button", { name: /view source publication/i })).toBeTruthy();
  });

  it("OMITS the source control when no source pmid is carried (pre-#1158 row)", () => {
    const { container } = render(
      <MethodsSection families={withContext({ CheXpert: SNIPPET }, {})} {...REDESIGN} />,
    );
    const rail = container.querySelector('[aria-live="polite"]') as HTMLElement;
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Usage example for CheXpert/ }));
    expect(within(rail).queryByRole("button", { name: /source publication/i })).toBeNull();
  });

  it("clicking the source control opens the in-app publication modal with the source pmid (Q-7)", () => {
    const { container } = render(
      <MethodsSection
        families={withContext({ CheXpert: SNIPPET }, { CheXpert: "33144353" })}
        {...REDESIGN}
      />,
    );
    const rail = container.querySelector('[aria-live="polite"]') as HTMLElement;
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Usage example for CheXpert/ }));
    fireEvent.click(within(rail).getByRole("button", { name: /view source publication/i }));
    expect(openMock).toHaveBeenCalledWith("33144353");
  });

  // HIGH#3 — the rail must stay in the DOM + a11y tree at ALL widths (it stacks
  // below the list on mobile). A `hidden`/`sm:block` class would display:none it
  // below 640px, making the snippet, source action, and aria-live announcement
  // unreachable on mobile (a regression vs the prior tap tooltip).
  it("keeps the provenance rail in the DOM at all widths (not display:none on mobile)", () => {
    const { container } = render(<MethodsSection families={withContext({ CheXpert: SNIPPET })} {...REDESIGN} />);
    const rail = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(rail).toBeTruthy();
    expect(rail.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });
});

// PROFILE_FACET_REDESIGN OFF (default / current prod) — the legacy renderer is
// retained and must stay byte-identical to the pre-redesign output: the #819
// filter pill, the #1119 "How <tool> was used" Radix tooltip, the flat 8-family
// cap, and NO provenance rail.
describe("MethodsSection — legacy (PROFILE_FACET_REDESIGN off)", () => {
  function withCtx(contexts: Record<string, string>): ScholarFamilyView[] {
    return [
      {
        familyId: "fam_1",
        familyLabel: "Chest radiograph models",
        supercategory: "imaging_microscopy",
        pubCount: 12,
        exemplarTools: ["CheXpert", "MIMIC-CXR"],
        pmids: ["1", "2"],
        definition: null,
        definitionSource: null,
        exemplarContexts: contexts,
        exemplarContextPmids: {},
      },
    ];
  }

  it("renders family labels, dot-joined exemplar tools, and counts", () => {
    render(<MethodsSection families={makeFamilies(2)} />);
    expect(screen.getByText("Family 1")).toBeTruthy();
    expect(screen.getByText("Tool 1A · Tool 1B")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
    expect(screen.getByText("99")).toBeTruthy();
  });

  it("uses the legacy 'How <tool> was used' tooltip and renders NO provenance rail", () => {
    const { container } = render(<MethodsSection families={withCtx({ CheXpert: "CheXpert labels chest radiographs" })} />);
    // Legacy affordance: the Radix tooltip trigger, NOT the rail's "Usage example".
    expect(screen.getByRole("button", { name: /How CheXpert was used/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Usage example for/ })).toBeNull();
    // No persistent rail in the legacy layout.
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it("caps at 8 families and shows a '+ N more' line for the remainder", () => {
    render(<MethodsSection families={makeFamilies(11)} />);
    expect(screen.getByText("Family 8")).toBeTruthy();
    expect(screen.queryByText("Family 9")).toBeNull();
    expect(screen.getByText(/\+ 3 more method families/)).toBeTruthy();
  });

  it("renders labels as static text when filtering is off (default)", () => {
    render(<MethodsSection families={makeFamilies(2)} />);
    expect(screen.queryByRole("button", { name: "Family 1" })).toBeNull();
    expect(screen.getByText("Family 1")).toBeTruthy();
  });

  it("renders the label as a toggle pill and pulls the count into it when selected", () => {
    const onFamilyToggle = vi.fn();
    render(
      <MethodsSection
        families={makeFamilies(2)}
        filterEnabled
        selectedFamilyIds={["fam_1"]}
        onFamilyToggle={onFamilyToggle}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Family 1/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(onFamilyToggle).toHaveBeenCalledWith("fam_1");
    // The selected row's count rides inside the pill, so the right-hand count
    // column is blank for that row (the count is inside the toggle button).
    const selectedRow = screen.getByText("Family 1").closest("li") as HTMLElement;
    expect(within(toggle).getByText("100")).toBeTruthy();
    expect(within(selectedRow).getAllByText("100")).toHaveLength(1);
  });
});
