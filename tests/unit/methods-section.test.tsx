import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MethodsSection } from "@/components/profile/methods-section";
import type { ScholarFamilyView } from "@/lib/api/profile";

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
  }));
}

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
          },
        ]}
      />,
    );
    expect(screen.getByText("Solo family")).toBeTruthy();
    // The mono exemplar line uses " · " joins; none should be present.
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it("renders nothing when there are no families", () => {
    const { container } = render(<MethodsSection families={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("caps at 8 families and shows a '+ N more' line for the remainder", () => {
    render(<MethodsSection families={makeFamilies(11)} />);
    expect(screen.getByText("Family 8")).toBeTruthy();
    expect(screen.queryByText("Family 9")).toBeNull();
    expect(screen.getByText("+ 3 more method families")).toBeTruthy();
  });

  it("uses the singular 'family' when exactly one is hidden", () => {
    render(<MethodsSection families={makeFamilies(9)} />);
    expect(screen.getByText("+ 1 more method family")).toBeTruthy();
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

describe("MethodsSection — #819 family click-to-filter", () => {
  it("renders labels as static text when filtering is off (default)", () => {
    render(<MethodsSection families={makeFamilies(2)} />);
    expect(screen.queryByRole("button", { name: /Family 1/ })).toBeNull();
    expect(screen.getByText("Family 1")).toBeTruthy();
  });

  it("renders labels as toggle buttons and fires onFamilyToggle(familyId) when enabled", () => {
    const onFamilyToggle = vi.fn();
    render(
      <MethodsSection
        families={makeFamilies(2)}
        filterEnabled
        selectedFamilyIds={[]}
        onFamilyToggle={onFamilyToggle}
      />,
    );
    const btn = screen.getByRole("button", { name: /Family 1/ });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(onFamilyToggle).toHaveBeenCalledWith("fam_1");
  });

  it("reflects the selected family with aria-pressed", () => {
    render(
      <MethodsSection
        families={makeFamilies(2)}
        filterEnabled
        selectedFamilyIds={["fam_2"]}
        onFamilyToggle={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Family 2/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: /Family 1/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("pulls the count into the selected pill and out of the row's count column", () => {
    render(
      <MethodsSection
        families={makeFamilies(2)}
        filterEnabled
        selectedFamilyIds={["fam_1"]}
        onFamilyToggle={() => {}}
      />,
    );
    // fam_1's count (100) rides INSIDE the selected pill (the toggle button)...
    const selected = screen.getByRole("button", { name: /Family 1/ });
    expect(within(selected).getByText("100")).toBeTruthy();
    // ...while the unselected fam_2 keeps its count in the right-hand column, not
    // inside its button.
    const unselected = screen.getByRole("button", { name: /Family 2/ });
    expect(within(unselected).queryByText("99")).toBeNull();
    expect(screen.getByText("99")).toBeTruthy();
  });
});

describe("MethodsSection — PROFILE_FACET_REDESIGN (flag on)", () => {
  it("renders an unselected bordered pill + plain count when nothing is selected and no familyCounts", () => {
    render(
      <MethodsSection
        families={makeFamilies(2)}
        filterEnabled
        selectedFamilyIds={[]}
        onFamilyToggle={() => {}}
        facetRedesignEnabled
      />,
    );
    const row = screen.getByText("Family 1").closest("li") as HTMLElement;
    // The whole pill is a toggle button (aria-label = family label).
    expect(within(row).getByRole("button", { name: "Family 1" })).toBeTruthy();
    expect(within(row).getByText("100")).toBeTruthy();
    // The unselected pill is a bordered rounded-full chip (no accent-slate fill).
    expect(row.innerHTML).toContain("rounded-full");
    expect(row.innerHTML).not.toContain("bg-[var(--color-accent-slate)]");
  });

  it("shows a filled accent-slate pill and a trailing remove (X) on the selected family", () => {
    render(
      <MethodsSection
        families={makeFamilies(2)}
        filterEnabled
        selectedFamilyIds={["fam_1"]}
        onFamilyToggle={() => {}}
        facetRedesignEnabled
      />,
    );
    const row = screen.getByText("Family 1").closest("li") as HTMLElement;
    // Selected pill carries the accent-slate fill and a remove control.
    expect(row.innerHTML).toContain("bg-[var(--color-accent-slate)]");
    expect(within(row).getByRole("button", { name: /Remove Family 1 filter/ })).toBeTruthy();
    // The trailing X remove control renders as an svg.
    expect(row.querySelectorAll("svg").length).toBeGreaterThanOrEqual(1);
  });

  it("renders contextual '{in} of {total}' counts from familyCounts", () => {
    const familyCounts = new Map<string, number>([
      ["fam_1", 6],
      ["fam_2", 5],
    ]);
    render(
      <MethodsSection
        families={makeFamilies(2)}
        filterEnabled
        selectedFamilyIds={["fam_1"]}
        onFamilyToggle={() => {}}
        facetRedesignEnabled
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
        filterEnabled
        selectedFamilyIds={["fam_1"]}
        onFamilyToggle={() => {}}
        facetRedesignEnabled
        familyCounts={familyCounts}
      />,
    );
    const zeroRow = screen.getByText("Family 2").closest("li") as HTMLElement;
    // The row's content + count carry the ~45% dim.
    expect(zeroRow.innerHTML).toContain("opacity-45");
    expect(within(zeroRow).getByText(/of 99/)).toBeTruthy();
  });

  it("keeps the #824 browse-out link independently present on a flag-on row", () => {
    render(
      <MethodsSection
        families={makeFamilies(2)}
        filterEnabled
        selectedFamilyIds={[]}
        onFamilyToggle={() => {}}
        pagesEnabled
        facetRedesignEnabled
      />,
    );
    const row = screen.getByText("Family 1").closest("li") as HTMLElement;
    // The browse-out target is a separate link (the row toggle is a button), so
    // it coexists with the whole-row toggle and stays its own click target.
    expect(within(row).getByRole("link", { name: /Researchers using Family 1/ })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Family 1" })).toBeTruthy();
  });
});

describe("MethodsSection — v2 budget / selected-zero / animation (#841)", () => {
  const redesignProps = {
    filterEnabled: true,
    onFamilyToggle: () => {},
    facetRedesignEnabled: true as const,
  };

  function rowsUl() {
    return screen.getByText("Family 1").closest("ul") as HTMLElement;
  }

  // #1 — cap UNSELECTED rows at 6 in the resting redesign panel.
  it("#1 caps unselected rows at 6 in the resting redesign panel", () => {
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

  it("#4 pagesEnabled adds no second navigating control in the redesign footer", () => {
    render(
      <MethodsSection
        families={makeFamilies(11)}
        selectedFamilyIds={[]}
        pagesEnabled
        {...redesignProps}
      />,
    );
    // The footer disclosure is a button, not a link — the only navigate-away
    // affordance is the heading's "Browse all methods", not the row footer.
    expect(screen.queryByRole("link", { name: /more method families/ })).toBeNull();
    expect(screen.getByRole("button", { name: /\+ 5 more method families/ })).toBeTruthy();
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
    // fam_1: selected + 0 → deliberate selected-zero (filled accent-slate pill,
    // full opacity).
    const selZero = screen.getByText("Family 1").closest("li") as HTMLElement;
    expect(selZero.getAttribute("data-selected-zero")).toBe("true");
    expect(selZero.innerHTML).toContain("bg-[var(--color-accent-slate)]");
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

  // #17 — redesign rows carry the chip-fill transition; flag-off rows do not.
  it("#17 redesign rows carry facet-chip-transition (and flag-off rows do not)", () => {
    const { rerender } = render(
      <MethodsSection families={makeFamilies(2)} selectedFamilyIds={["fam_1"]} {...redesignProps} />,
    );
    const sel = screen.getByText("Family 1").closest("li") as HTMLElement;
    const unsel = screen.getByText("Family 2").closest("li") as HTMLElement;
    expect(sel.className).toContain("facet-chip-transition");
    expect(unsel.className).toContain("facet-chip-transition");

    rerender(
      <MethodsSection
        families={makeFamilies(2)}
        filterEnabled
        selectedFamilyIds={["fam_1"]}
        onFamilyToggle={() => {}}
      />,
    );
    const offRow = screen.getByText("Family 2").closest("li") as HTMLElement;
    expect(offRow.className).not.toContain("facet-chip-transition");
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

// #1119 — per-exemplar-tool usage hover. When a tool has an `exemplarContexts`
// snippet (server-populated only under METHODS_LENS_TOOL_CONTEXT), the tool name
// becomes a hover trigger; tools without one stay plain text.
describe("MethodsSection — #1119 per-tool usage hover", () => {
  function withContext(contexts: Record<string, string>): ScholarFamilyView[] {
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
      },
    ];
  }

  it("renders a hover trigger for a tool that has a usage snippet, plain text otherwise", async () => {
    render(
      <MethodsSection
        families={withContext({ CheXpert: "labels chest radiographs across 14 observations" })}
      />,
    );
    const trigger = screen.getByRole("button", { name: "How CheXpert was used" });
    expect(trigger).toBeTruthy();
    // MIMIC-CXR has no snippet → no trigger for it.
    expect(screen.queryByRole("button", { name: "How MIMIC-CXR was used" })).toBeNull();
    fireEvent.focus(trigger);
    await waitFor(() =>
      expect(
        screen.getAllByText(/labels chest radiographs across 14 observations/).length,
      ).toBeGreaterThan(0),
    );
  });

  it("renders the plain dotted join when no tool has a snippet (flag-off path)", () => {
    render(<MethodsSection families={withContext({})} />);
    expect(screen.getByText("CheXpert · MIMIC-CXR")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /How .* was used/ })).toBeNull();
  });
});
