/**
 * `EditShell`'s `readOnly` / `contentInert` props (#2482, the `cv_generator`
 * role) — `readOnly` swaps the superuser banner's "editing … as an
 * administrator" claim for an honest "viewing … read-only" line;
 * `contentInert` (defaults to `readOnly`) makes the panel content native
 * `inert` (unfocusable/unclickable, still fully visible). They're split apart
 * so the CV-export panel can stay interactive (`contentInert={false}`) while
 * the banner still tells the truth (`readOnly={true}`) — CV export never
 * writes anything. Default (both unset) is byte-identical to the existing
 * shell.
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

  it("contentInert=false keeps the panel interactive even while readOnly=true (the CV-export exception, #2482)", () => {
    render(
      <EditShell {...base} readOnly contentInert={false}>
        <button type="button" data-testid="download-cv">
          Download CV (WCM format)
        </button>
      </EditShell>,
    );
    // The button stays clickable...
    expect(screen.getByTestId("download-cv").closest("[inert]")).toBeNull();
    // ...but the banner still tells the truth about the role.
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("read-only");
    expect(banner.textContent).not.toContain("as an administrator");
  });

  it("contentInert defaults to readOnly when omitted", () => {
    render(
      <EditShell {...base} readOnly>
        <button type="button" data-testid="the-button">
          Hide
        </button>
      </EditShell>,
    );
    expect(screen.getByTestId("the-button").closest("[inert]")).not.toBeNull();
  });
});
