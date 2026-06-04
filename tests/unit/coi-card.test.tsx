/**
 * `components/edit/coi-card.tsx` — the read-only Conflicts of Interest panel
 * (#160 follow-up). COI is NOT suppressible (managed in the Weill Research
 * Gateway); the panel groups disclosures like the profile, shows the "not
 * editable" treatment, and routes corrections to WRG via Request a Change.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { CoiCard } from "@/components/edit/coi-card";
import type { EditContextCoiDisclosure } from "@/lib/api/edit-context";

const DISCLOSURES: EditContextCoiDisclosure[] = [
  { entity: "Zeta Co", activityGroup: "Ownership" },
  { entity: "Alpha Co", activityGroup: "Ownership" },
  { entity: "Globex Pharma", activityGroup: "Leadership Roles" },
];

describe("CoiCard — read-only conflicts of interest", () => {
  it("renders the not-editable treatment + a Request a Change trigger (no hide control)", () => {
    render(<CoiCard cwid="self01" mode="self" scholarName="Alex Self" disclosures={DISCLOSURES} />);
    expect(screen.getByText("This section is not editable.")).toBeTruthy();
    expect(screen.getByTestId("request-a-change-toggle")).toBeTruthy();
    // Read-only: there must be no Hide/Show buttons anywhere.
    expect(screen.queryByRole("button", { name: /hide/i })).toBeNull();
  });

  it("groups disclosures by activityGroup in COI_GROUP_ORDER (Leadership before Ownership)", () => {
    render(<CoiCard cwid="self01" mode="self" scholarName="Alex Self" disclosures={DISCLOSURES} />);
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent?.replace(/About.*/, "").trim());
    expect(headings).toEqual(["Leadership Roles", "Ownership"]);
  });

  it("dedups + alpha-sorts entities within a group", () => {
    render(<CoiCard cwid="self01" mode="self" scholarName="Alex Self" disclosures={DISCLOSURES} />);
    const ownership = screen.getByTestId("coi-group-Ownership");
    expect(within(ownership).getByText("Alpha Co; Zeta Co")).toBeTruthy();
  });

  it("shows the self empty state when there are no disclosures", () => {
    render(<CoiCard cwid="self01" mode="self" scholarName="Alex Self" disclosures={[]} />);
    expect(screen.getByTestId("coi-empty").textContent).toMatch(/you have no/i);
  });

  it("shows the superuser empty-state phrasing for a different scholar", () => {
    render(<CoiCard cwid="other7" mode="superuser" scholarName="Alex Other" disclosures={[]} />);
    expect(screen.getByTestId("coi-empty").textContent).toMatch(/this scholar has no/i);
  });
});
