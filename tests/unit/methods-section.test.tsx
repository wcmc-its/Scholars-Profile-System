import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      expect.stringContaining("/api/edit/methods-sensitive/aog"),
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
});
