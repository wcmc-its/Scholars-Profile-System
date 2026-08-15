/**
 * `RailSheet`, the mobile stand-in for the ATTRIBUTES rail. Covers: the
 * trigger names the active item's group + label + position, opening it reveals
 * the real rail links, and picking one closes the sheet.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/edit",
}));

import { RailSheet } from "@/components/edit/rail-sheet";
import type { RailItem } from "@/components/edit/attribute-rail";

const ITEMS: ReadonlyArray<RailItem> = [
  { key: "overview", label: "Overview", group: "Yours to edit" },
  { key: "appointments", label: "Appointments", group: "From WCM systems", readonly: true },
];

describe("RailSheet", () => {
  it("names the active item's group, label, and position on the trigger", () => {
    render(<RailSheet items={ITEMS} active="appointments" basePath="/edit" />);
    const trigger = screen.getByTestId("rail-sheet-trigger");
    expect(trigger.textContent).toContain("From WCM systems");
    expect(trigger.textContent).toContain("Appointments");
    expect(trigger.textContent).toContain("2 / 2");
  });

  it("opens the real AttributeRail links on click", () => {
    render(<RailSheet items={ITEMS} active="overview" basePath="/edit" />);
    expect(screen.queryByTestId("rail-overview")).toBeNull();
    fireEvent.click(screen.getByTestId("rail-sheet-trigger"));
    expect(screen.getByTestId("rail-overview")).toBeTruthy();
    expect(screen.getByTestId("rail-appointments")).toBeTruthy();
  });

  it("closes the sheet when a rail link is picked", () => {
    render(<RailSheet items={ITEMS} active="overview" basePath="/edit" />);
    fireEvent.click(screen.getByTestId("rail-sheet-trigger"));
    fireEvent.click(screen.getByTestId("rail-appointments"));
    expect(screen.queryByTestId("rail-appointments")).toBeNull();
  });
});
