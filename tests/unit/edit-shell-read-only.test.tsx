/**
 * `EditShell`'s `readOnly` prop (#2482, the `cv_generator` role) — every write
 * affordance in the panel is made native `inert` (unfocusable/unclickable,
 * still fully visible) and the superuser banner swaps its "editing … as an
 * administrator" claim for an honest "viewing … read-only" line. Default
 * (`readOnly` unset) is byte-identical to the existing shell.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/site/account-menu", () => ({ AccountMenu: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/edit",
}));

import { EditShell } from "@/components/edit/edit-shell";

const base = {
  mode: "superuser" as const,
  scholarName: "Jane Scholar",
  railItems: [{ key: "home", label: "Home" }],
  activeAttr: "home",
  basePath: "/edit/scholar/abc1001",
};

describe("EditShell — readOnly", () => {
  it("panel content is NOT inert by default", () => {
    render(
      <EditShell {...base}>
        <button type="button" data-testid="the-button">
          Hide
        </button>
      </EditShell>,
    );
    expect(screen.getByTestId("the-button").closest("[inert]")).toBeNull();
  });

  it("wraps the panel content in a native inert container when readOnly", () => {
    render(
      <EditShell {...base} readOnly>
        <button type="button" data-testid="the-button">
          Hide
        </button>
      </EditShell>,
    );
    expect(screen.getByTestId("the-button").closest("[inert]")).not.toBeNull();
  });

  it("swaps the superuser banner to the read-only 'viewing' copy when readOnly", () => {
    render(
      <EditShell {...base} readOnly>
        <div>panel</div>
      </EditShell>,
    );
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("viewing");
    expect(banner.textContent).toContain("read-only");
    expect(banner.textContent).not.toContain("as an administrator");
  });

  it("keeps the normal 'editing … as an administrator' banner when readOnly is unset", () => {
    render(
      <EditShell {...base}>
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.getByRole("alert").textContent).toContain("as an administrator");
  });
});
