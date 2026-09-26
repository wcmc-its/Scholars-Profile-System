/**
 * UX feedback A1/A3 — the supercategory family rail.
 *
 * Verifies the row shows the DISTINCT publication count (never clipped, with its
 * "pubs" caption + accessible label) rather than the bare scholar count that was
 * getting clipped, and that the (now family-unioned) exemplar tools render as a
 * middot-joined line. Pure render test — no DB.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FamilyRail, type FamilyRailItem } from "@/components/method/family-rail";

const families: FamilyRailItem[] = [
  { familyId: "fam_0001", familyLabel: "Deep learning segmentation", scholarCount: 96, pubCount: 241, exemplarTools: ["CNN", "U-Net", "ResNet"] },
  { familyId: "fam_0002", familyLabel: "MRI biomarkers", scholarCount: 61, pubCount: 178, exemplarTools: ["T1", "T2"] },
];

describe("FamilyRail", () => {
  it("shows the DISTINCT publication count with a 'pubs' caption (A1 — papers, not scholars)", () => {
    render(<FamilyRail families={families} activeFamilyId={null} onSelect={() => {}} />);
    expect(screen.getByText("241")).toBeTruthy();
    expect(screen.getByText("178")).toBeTruthy();
    // The scholar count (96/61) is NOT the visible number anymore.
    expect(screen.queryByText("96")).toBeNull();
    expect(screen.getAllByText("pubs").length).toBe(2);
  });

  it("exposes both counts to assistive tech via the row's aria-label", () => {
    const { container } = render(
      <FamilyRail families={families} activeFamilyId={null} onSelect={() => {}} />,
    );
    const labelled = container.querySelector('[aria-label="241 publications, 96 scholars"]');
    expect(labelled).toBeTruthy();
  });

  it("renders the family-unioned exemplar tools as a middot-joined line (A3)", () => {
    render(<FamilyRail families={families} activeFamilyId={null} onSelect={() => {}} />);
    expect(screen.getByText("CNN · U-Net · ResNet")).toBeTruthy();
    expect(screen.getByText("T1 · T2")).toBeTruthy();
  });

  it("selecting a family row invokes onSelect with its familyId", () => {
    let picked: string | null = "none";
    render(
      <FamilyRail families={families} activeFamilyId={null} onSelect={(id) => (picked = id)} />,
    );
    fireEvent.click(screen.getByText("MRI biomarkers"));
    expect(picked).toBe("fam_0002");
  });
});
