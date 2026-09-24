/**
 * DeptTabs — the countless Collaboration tab (Unit Page v2, department pages).
 * Assertions are scoped to the rendered container.
 */
import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { DeptTabs } from "@/components/department/dept-tabs";

const BASE = {
  basePath: "/departments/x",
  scholarsCount: 12,
  publicationsCount: 34,
  grantsCount: 5,
};

function tabLabels(container: HTMLElement): string[] {
  return within(container)
    .getAllByRole("tab")
    .map((t) => t.textContent ?? "");
}

describe("DeptTabs — Collaboration tab", () => {
  it("appends a countless, enabled Collaboration tab last when showCollaboration is set", () => {
    const { container } = render(
      <DeptTabs active="scholars" {...BASE} showCollaboration />,
    );
    expect(tabLabels(container)).toEqual([
      "Scholars12",
      "Publications34",
      "Grants5",
      "Collaboration",
    ]);
    const tab = within(container).getByRole("tab", { name: "Collaboration" });
    expect(tab.getAttribute("href")).toBe("/departments/x?tab=collaboration#tab-content");
    expect(tab.getAttribute("aria-disabled")).toBeNull();
    expect(tab.getAttribute("aria-selected")).toBe("false");
    // No count badge.
    expect(tab.querySelector("span")).toBeNull();
  });

  it("marks the Collaboration tab selected when active", () => {
    const { container } = render(
      <DeptTabs active="collaboration" {...BASE} showCollaboration />,
    );
    const tab = within(container).getByRole("tab", { name: "Collaboration" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(
      within(container).getByRole("tab", { name: /Scholars/ }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("division-page usage (prop unset) renders exactly the old tabs", () => {
    const { container } = render(<DeptTabs active="scholars" {...BASE} />);
    expect(tabLabels(container)).toEqual(["Scholars12", "Publications34", "Grants5"]);
    expect(within(container).queryByRole("tab", { name: "Collaboration" })).toBeNull();
  });
});
