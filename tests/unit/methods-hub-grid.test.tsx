/**
 * UX feedback B5/B6 — the `/methods` hub grid.
 *
 * Verifies the hub now exposes the families under each supercategory and that each
 * family link deep-links to that family on the supercategory page via the STABLE
 * family slug `?family={labelSlug}-{familyId}` (#940 — not the bare re-minted id),
 * which scrolls the panel into view. Pure render test.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MethodsHubGrid } from "@/components/method/methods-hub-grid";
import type { SupercategoryHubEntry } from "@/lib/api/methods";

const items: SupercategoryHubEntry[] = [
  {
    id: "imaging_image_analysis",
    slug: "imaging-image-analysis",
    label: "Imaging & image analysis",
    description: "desc",
    familyCount: 2,
    families: [
      { familyId: "fam_0001", familyLabel: "Deep learning segmentation", scholarCount: 96 },
      { familyId: "fam_0002", familyLabel: "MRI biomarkers", scholarCount: 61 },
    ],
  },
];

describe("MethodsHubGrid", () => {
  it("renders each family under its supercategory (B5)", () => {
    render(<MethodsHubGrid items={items} />);
    expect(screen.getByText("Imaging & image analysis")).toBeTruthy();
    expect(screen.getByText("Deep learning segmentation")).toBeTruthy();
    expect(screen.getByText("MRI biomarkers")).toBeTruthy();
  });

  it("deep-links each family to ?family={stable-slug} on the supercategory page (B6, #940)", () => {
    render(<MethodsHubGrid items={items} />);
    // The deep-link carries the stable label-slug + id so a cached link self-heals
    // across A2 rebuilds that re-mint the bare `fam_NNNN` id.
    const fam1 = screen.getByText("Deep learning segmentation").closest("a");
    expect(fam1?.getAttribute("href")).toBe(
      "/methods/imaging-image-analysis?family=deep-learning-segmentation-fam_0001",
    );
    const fam2 = screen.getByText("MRI biomarkers").closest("a");
    expect(fam2?.getAttribute("href")).toBe(
      "/methods/imaging-image-analysis?family=mri-biomarkers-fam_0002",
    );
  });

  it("keeps the supercategory heading linking to its page", () => {
    render(<MethodsHubGrid items={items} />);
    const head = screen.getByText("Imaging & image analysis").closest("a");
    expect(head?.getAttribute("href")).toBe("/methods/imaging-image-analysis");
  });
});
