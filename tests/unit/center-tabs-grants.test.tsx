/**
 * Center Grants tab (Unit Page v2): reinstated after §16 (#52) removed it.
 */
import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { CenterTabs } from "@/components/center/center-tabs";

function renderTabs(over: Partial<Parameters<typeof CenterTabs>[0]> = {}) {
  const { container } = render(
    <CenterTabs
      active="scholars"
      basePath="/centers/test-center"
      scholarsCount={12}
      publicationsCount={340}
      grantsCount={7}
      {...over}
    />,
  );
  return within(container);
}

describe("CenterTabs — Grants", () => {
  it("orders Scholars, Publications, Grants, then Collaboration", () => {
    const tabs = renderTabs({ showCollaboration: true }).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/[\d,]/g, "").trim())).toEqual([
      "Scholars",
      "Publications",
      "Grants",
      "Collaboration",
    ]);
  });

  it("links Grants to ?tab=grants#tab-content with its count", () => {
    const grants = renderTabs().getByRole("tab", { name: /Grants/ });
    expect(grants.getAttribute("href")).toBe("/centers/test-center?tab=grants#tab-content");
    expect(grants.textContent).toContain("7");
  });

  it("renders a disabled span, not a link, when there are no grants", () => {
    const grants = renderTabs({ grantsCount: 0 }).getByRole("tab", { name: /Grants/ });
    expect(grants.tagName).toBe("SPAN");
    expect(grants.getAttribute("aria-disabled")).toBe("true");
    expect(grants.getAttribute("href")).toBeNull();
  });

  it("marks Grants selected when active", () => {
    const grants = renderTabs({ active: "grants" }).getByRole("tab", { name: /Grants/ });
    expect(grants.getAttribute("aria-selected")).toBe("true");
  });
});
