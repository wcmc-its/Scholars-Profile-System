/**
 * `components/edit/unit-admin-banner.tsx` — the org-unit-administrator banner
 * (Amendment 4 / scholar-proxy-unit-admin-amendment.md). Server Component: no
 * interactivity, no state — only the rendered output is under test.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { UnitAdminBanner } from "@/components/edit/unit-admin-banner";

describe("UnitAdminBanner", () => {
  it("names the scholar and the conferring unit ('via {unit} administrator')", () => {
    render(<UnitAdminBanner targetLabel="Alex Other" unitKind="department" unitName="Medicine" />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("editing");
    expect(banner.textContent).toContain("Alex Other");
    expect(banner.textContent).toContain("administrator");
    expect(banner.textContent).toContain("department");
    expect(banner.textContent).toContain("Medicine");
  });

  it("emphasizes the scholar name and the unit name in <strong>", () => {
    render(<UnitAdminBanner targetLabel="Jane Roe" unitKind="division" unitName="Cardiology" />);
    const strongs = Array.from(screen.getByRole("alert").querySelectorAll("strong")).map(
      (s) => s.textContent,
    );
    expect(strongs).toContain("Jane Roe");
    expect(strongs).toContain("Cardiology");
  });

  it("reflects the division kind in the copy", () => {
    render(<UnitAdminBanner targetLabel="Jane" unitKind="division" unitName="Cardiology" />);
    expect(screen.getByRole("alert").textContent).toContain("division");
  });

  it("uses the `info` variant and the `unit-admin-banner` data-slot", () => {
    render(<UnitAdminBanner targetLabel="Jane" unitKind="department" unitName="Medicine" />);
    const banner = screen.getByRole("alert");
    expect(banner.getAttribute("data-variant")).toBe("info");
    expect(banner.getAttribute("data-slot")).toBe("unit-admin-banner");
  });

  it("renders an icon (an svg child of the alert)", () => {
    render(<UnitAdminBanner targetLabel="Jane" unitKind="department" unitName="Medicine" />);
    expect(screen.getByRole("alert").querySelector("svg")).not.toBeNull();
  });
});
