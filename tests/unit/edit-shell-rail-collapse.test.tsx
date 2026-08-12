/**
 * The `md`+ ATTRIBUTES-rail collapse toggle (`RailCollapse`, wrapped around the
 * rail column by `EditShell`). Covers: default-expanded (today's behavior,
 * unchanged), toggling collapses the rail, the collapsed choice persists across
 * a re-mount via localStorage, and the existing mobile `RailSelect` `<select>`
 * fallback is untouched by any of this.
 *
 * `AccountMenu` fires an impersonation-probe fetch on mount, so it's mocked out
 * like the sibling `edit-shell-history-link.test.tsx` suite.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/components/site/account-menu", () => ({ AccountMenu: () => null }));
// EditShell's rail children (RailSelect / AttributeRail) read the router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/edit",
}));

import { EditShell } from "@/components/edit/edit-shell";
import type { RailItem } from "@/components/edit/attribute-rail";

const RAIL_ITEMS: ReadonlyArray<RailItem> = [
  { key: "overview", label: "Overview" },
  { key: "appointments", label: "Appointments", readonly: true },
];

const base = {
  mode: "self" as const,
  scholarName: "Jane Doe",
  railItems: RAIL_ITEMS,
  activeAttr: "overview",
  basePath: "/edit",
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("EditShell — desktop rail collapse toggle", () => {
  it("renders the rail expanded by default (today's behavior, unchanged)", () => {
    render(
      <EditShell {...base}>
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.getByTestId("rail-expanded")).toBeTruthy();
    expect(screen.queryByTestId("rail-collapsed")).toBeNull();
    // The rail links still render (AttributeRail passed straight through).
    expect(screen.getByTestId("rail-overview")).toBeTruthy();
    expect(screen.getByTestId("rail-collapse-toggle").getAttribute("aria-label")).toBe(
      "Collapse attributes rail",
    );
  });

  it("clicking the toggle collapses the rail to the thin affordance strip", () => {
    render(
      <EditShell {...base}>
        <div>panel</div>
      </EditShell>,
    );
    fireEvent.click(screen.getByTestId("rail-collapse-toggle"));
    expect(screen.getByTestId("rail-collapsed")).toBeTruthy();
    expect(screen.queryByTestId("rail-expanded")).toBeNull();
    // The rail links are gone, but a re-expand affordance remains.
    expect(screen.queryByTestId("rail-overview")).toBeNull();
    const toggle = screen.getByTestId("rail-collapse-toggle");
    expect(toggle.getAttribute("aria-label")).toBe("Expand attributes rail");
  });

  it("persists the collapsed choice to localStorage and restores it on re-mount", () => {
    const { unmount } = render(
      <EditShell {...base}>
        <div>panel</div>
      </EditShell>,
    );
    fireEvent.click(screen.getByTestId("rail-collapse-toggle"));
    expect(window.localStorage.getItem("edit-shell:rail-collapsed")).toBe("1");
    unmount();

    // A fresh mount reads the sticky choice and opens already collapsed.
    render(
      <EditShell {...base}>
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.getByTestId("rail-collapsed")).toBeTruthy();
    expect(screen.queryByTestId("rail-expanded")).toBeNull();
  });

  it("toggling back to expanded persists too", () => {
    render(
      <EditShell {...base}>
        <div>panel</div>
      </EditShell>,
    );
    const toggle = screen.getByTestId("rail-collapse-toggle");
    fireEvent.click(toggle); // collapse
    fireEvent.click(screen.getByTestId("rail-collapse-toggle")); // expand again
    expect(window.localStorage.getItem("edit-shell:rail-collapsed")).toBe("0");
    expect(screen.getByTestId("rail-expanded")).toBeTruthy();
  });

  it("leaves the existing mobile RailSelect <select> path untouched", () => {
    render(
      <EditShell {...base}>
        <div>panel</div>
      </EditShell>,
    );
    // The mobile <select> fallback renders regardless of the desktop toggle
    // and is unaffected by collapsing the rail.
    const select = screen.getByTestId("rail-select") as HTMLSelectElement;
    expect(select.value).toBe("overview");
    fireEvent.click(screen.getByTestId("rail-collapse-toggle"));
    expect((screen.getByTestId("rail-select") as HTMLSelectElement).value).toBe("overview");
  });
});
