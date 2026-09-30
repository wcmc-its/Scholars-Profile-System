/**
 * UX feedback A1/A3: the supercategory family rail, now `TaxonomyRail` fed by
 * `familyRailRow`, plus the family page's entity rows (`entityRailRow`).
 *
 * Verifies the row shows the DISTINCT publication count (never clipped, with its
 * "pubs" caption + accessible label) rather than the bare scholar count, and
 * that the exemplar tools render as a middot-joined line. Pure render test.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaxonomyRail } from "@/components/taxonomy/taxonomy-rail";
import {
  familyRailRow,
  type FamilyRailItem,
} from "@/components/method/supercategory-rail-layout";
import { entityRailRow } from "@/components/method/family-entity-rail-layout";
import type { CellLineEntity } from "@/lib/api/methods";

vi.mock("@/components/taxonomy/publication-feed", () => ({ FamilyPublicationFeed: () => null }));
vi.mock("@/components/method/family-scholars-row", () => ({ FamilyScholarsRow: () => null }));
vi.mock("@/components/method/supercategory-all-work-feed", () => ({
  SupercategoryAllWorkFeed: () => null,
}));

const families: FamilyRailItem[] = [
  { familyId: "fam_0001", familyLabel: "Deep learning segmentation", scholarCount: 96, pubCount: 241, exemplarTools: ["CNN", "U-Net", "ResNet"] },
  { familyId: "fam_0002", familyLabel: "MRI biomarkers", scholarCount: 61, pubCount: 178, exemplarTools: ["T1", "T2"] },
];

function FamilyRail({
  activeFamilyId,
  onSelect,
}: {
  activeFamilyId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <TaxonomyRail
      items={families.map(familyRailRow)}
      selectedId={activeFamilyId}
      onSelect={onSelect}
      railLabel="Method families"
      headerText={`FAMILIES (${families.length})`}
      filterPlaceholder="Filter families…"
      noMatchNoun="families"
      variant="captioned"
    />
  );
}

describe("TaxonomyRail (family configuration)", () => {
  it("shows the DISTINCT publication count with a 'pubs' caption (A1: papers, not scholars)", () => {
    render(<FamilyRail activeFamilyId={null} onSelect={() => {}} />);
    expect(screen.getByText("241")).toBeTruthy();
    expect(screen.getByText("178")).toBeTruthy();
    expect(screen.queryByText("96")).toBeNull();
    expect(screen.getAllByText("pubs").length).toBe(2);
  });

  it("exposes both counts to assistive tech via the row's aria-label", () => {
    const { container } = render(<FamilyRail activeFamilyId={null} onSelect={() => {}} />);
    expect(container.querySelector('[aria-label="241 publications, 96 scholars"]')).toBeTruthy();
  });

  it("renders the family-unioned exemplar tools as a middot-joined line (A3)", () => {
    render(<FamilyRail activeFamilyId={null} onSelect={() => {}} />);
    expect(screen.getByText("CNN · U-Net · ResNet")).toBeTruthy();
    expect(screen.getByText("T1 · T2")).toBeTruthy();
  });

  it("selecting a family row invokes onSelect with its familyId; re-clicking toggles off", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<FamilyRail activeFamilyId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("MRI biomarkers"));
    expect(onSelect).toHaveBeenLastCalledWith("fam_0002");
    rerender(<FamilyRail activeFamilyId="fam_0002" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("MRI biomarkers"));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});

describe("TaxonomyRail (entity configuration)", () => {
  const base = {
    parentLabel: null,
    parentDescriptor: null,
    isGeneric: false,
    dominantKind: "organism_or_cells",
  };
  const entities = [
    { ...base, entityId: "e1", label: "HEK293", parentDescriptor: "human embryonic kidney", usageCount: 40, evidenced: true },
    { ...base, entityId: "e2", label: "HeLa", usageCount: 12, evidenced: false },
    { ...base, entityId: "e3", label: "macrophage cell line", usageCount: 9, evidenced: true, isGeneric: true },
  ] as unknown as CellLineEntity[];

  function EntityRail({ onSelect }: { onSelect: (id: string | null) => void }) {
    return (
      <TaxonomyRail
        items={entities.map(entityRailRow)}
        selectedId={null}
        onSelect={onSelect}
        railLabel="Cell lines"
        headerText="CELL LINES (3)"
        filterPlaceholder="Filter cell lines…"
        noMatchNoun="cell lines"
        variant="captioned"
      />
    );
  }

  it("only evidenced, non-generic entities are selectable", () => {
    const onSelect = vi.fn();
    render(<EntityRail onSelect={onSelect} />);
    expect(screen.getByText("HEK293").closest("button")).toBeTruthy();
    expect(screen.getByText("HeLa").closest("button")).toBeNull();
    expect(screen.getByText("macrophage cell line").closest("button")).toBeNull();
    fireEvent.click(screen.getByText("HEK293"));
    expect(onSelect).toHaveBeenCalledWith("e1");
  });

  it("renders the lineage descriptor, 'papers' caption, and evidence-aware aria label", () => {
    const { container } = render(<EntityRail onSelect={() => {}} />);
    expect(screen.getByText("human embryonic kidney")).toBeTruthy();
    expect(screen.getAllByText("papers").length).toBe(3);
    expect(
      container.querySelector('[aria-label="HeLa, 12 papers (no verbatim evidence recorded)"]'),
    ).toBeTruthy();
  });
});
