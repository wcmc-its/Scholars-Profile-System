/**
 * `EditShell`'s `readOnly` / `contentInert` props (the observer's read-only
 * role) — `readOnly` swaps the header role pill's "Editing as administrator"
 * for an honest "View only" (and drops "Changes are logged…");
 * `contentInert` (defaults to `readOnly`) makes the panel content native
 * `inert` (unfocusable/unclickable, still fully visible). They're split apart
 * so the CV-export panel can stay interactive (`contentInert={false}`) while
 * the pill still tells the truth (`readOnly={true}`) — CV export never
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

const pill = () => document.querySelector('[data-slot="edit-role-pill"]');

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

  it("swaps the role pill to 'View only' and drops 'Changes are logged' when readOnly", () => {
    render(
      <EditShell {...base} readOnly historyHref="/edit/scholar/abc1001/history">
        <div>panel</div>
      </EditShell>,
    );
    expect(pill()?.textContent).toBe("View only");
    expect(document.body.textContent).not.toContain("Changes are logged");
    // History visibility == access, so the link itself survives.
    expect(screen.getByTestId("edit-history-link")).toBeTruthy();
  });

  it("keeps 'Editing as administrator' + 'Changes are logged…' when readOnly is unset", () => {
    render(
      <EditShell {...base}>
        <div>panel</div>
      </EditShell>,
    );
    expect(pill()?.textContent).toBe("Editing as administrator");
    expect(document.body.textContent).toContain("Changes are logged to your account");
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
    // ...but the pill still tells the truth about the role.
    expect(pill()?.textContent).toBe("View only");
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
