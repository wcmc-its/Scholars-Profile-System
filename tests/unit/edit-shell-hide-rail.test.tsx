/**
 * `EditShell`'s `hideRail` — one attribute (the Cancer Center Members table)
 * needs the whole width, not a shared column with a 9-item rail it has no
 * room to use. `hideRail` drops both the desktop rail and the phone
 * `<select>` swap, replacing them with a single "← Back" link (`backHref`).
 * Default (`hideRail` unset) is byte-identical to the existing shell —
 * covered by `edit-shell-history-link.test.tsx` / `edit-shell-rail-collapse
 * .test.tsx`, not repeated here.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/site/account-menu", () => ({ AccountMenu: () => null }));
// EditShell's rail children (RailSelect / AttributeRail) read the router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/edit",
}));

import { EditShell } from "@/components/edit/edit-shell";

const base = {
  mode: "superuser" as const,
  scholarName: "Sandra and Edward Meyer Cancer Center",
  railItems: [
    { key: "description", label: "Description" },
    { key: "roster", label: "Members" },
  ],
  activeAttr: "roster",
  basePath: "/edit/center/meyer_cancer_center",
};

describe("EditShell — hideRail", () => {
  it("renders the rail (desktop) and RailSelect (phone) when unset — the default", () => {
    render(
      <EditShell {...base}>
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.getByTestId("rail-description")).toBeTruthy();
    expect(screen.getByTestId("rail-select")).toBeTruthy();
    expect(screen.queryByTestId("edit-rail-back")).toBeNull();
  });

  it("drops the rail AND the phone select when hideRail is true", () => {
    render(
      <EditShell {...base} hideRail backHref="/edit/center/meyer_cancer_center">
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.queryByTestId("rail-description")).toBeNull();
    expect(screen.queryByTestId("rail-select")).toBeNull();
  });

  it("renders a Back link to backHref in the rail's place", () => {
    render(
      <EditShell {...base} hideRail backHref="/edit/center/meyer_cancer_center">
        <div>panel</div>
      </EditShell>,
    );
    const back = screen.getByTestId("edit-rail-back");
    expect(back.getAttribute("href")).toBe("/edit/center/meyer_cancer_center");
    expect(back.textContent).toContain("Back");
  });

  it("omits the Back link when hideRail is true but no backHref is given", () => {
    render(
      <EditShell {...base} hideRail>
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.queryByTestId("edit-rail-back")).toBeNull();
  });

  it("still renders children full-width", () => {
    render(
      <EditShell {...base} hideRail backHref="/edit/center/meyer_cancer_center">
        <div data-testid="the-panel">panel content</div>
      </EditShell>,
    );
    expect(screen.getByTestId("the-panel").textContent).toBe("panel content");
  });

  // Regression: hideRail used to drop subRail (a center's Reports link, or a
  // department's sibling-divisions nav) along with the attribute rail, even
  // though it's cross-nav unrelated to the attribute switcher hideRail exists
  // to hide. It now renders in the main column instead of disappearing.
  it("still renders subRail when hideRail is true", () => {
    render(
      <EditShell
        {...base}
        hideRail
        backHref="/edit/center/meyer_cancer_center"
        subRail={<div data-testid="the-sub-rail">Reports</div>}
      >
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.getByTestId("the-sub-rail").textContent).toBe("Reports");
  });
});
