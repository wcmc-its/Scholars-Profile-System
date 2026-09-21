/**
 * Design round 3 (2026-09-21) — the `/edit` shell's identity header: initials
 * avatar, "{name}, {postnominal}", "{title} · {institution}", with the button
 * row on its right. Edit-for-others only: it never renders in self mode, even
 * when `identity` is supplied.
 *
 * `AccountMenu` is a client component that fires an impersonation-probe fetch on
 * mount, so it's mocked out — this suite only exercises the shell's header.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/site/account-menu", () => ({ AccountMenu: () => null }));
// EditShell's rail children (RailSheet / AttributeRail) read the router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/edit",
}));

import { EditShell } from "@/components/edit/edit-shell";

const base = {
  scholarName: "Jane Doe",
  railItems: [],
  activeAttr: "overview",
  basePath: "/edit/scholar/abc1001",
  historyHref: "/edit/scholar/abc1001/history",
  previewHref: "https://example.test/jane",
};

const identity = {
  postnominal: "PhD",
  title: "Professor of Medicine",
  institution: "Weill Cornell Medicine",
};

describe("EditShell — identity header (design round 3)", () => {
  it("renders avatar initials, name + postnominal, and title · institution in superuser mode", () => {
    render(
      <EditShell {...base} mode="superuser" identity={identity}>
        <div>panel</div>
      </EditShell>,
    );
    const header = screen.getByTestId("edit-identity-header");
    expect(header.textContent).toContain("JD");
    expect(header.textContent).toContain("Jane Doe, PhD");
    expect(header.textContent).toContain("Professor of Medicine · Weill Cornell Medicine");
    // The button row still renders beside it.
    expect(screen.getByTestId("edit-history-link")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Preview profile/ })).toBeTruthy();
  });

  it("omits the comma when there is no postnominal and the dot when only one subline part exists", () => {
    render(
      <EditShell
        {...base}
        mode="proxy"
        identity={{ postnominal: null, title: null, institution: "Weill Cornell Medicine" }}
      >
        <div>panel</div>
      </EditShell>,
    );
    const header = screen.getByTestId("edit-identity-header");
    expect(header.textContent).not.toContain("Jane Doe,");
    expect(header.textContent).not.toContain("·");
    expect(header.textContent).toContain("Weill Cornell Medicine");
  });

  it("never renders in self mode, even when identity is supplied", () => {
    render(
      <EditShell {...base} mode="self" identity={identity}>
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.queryByTestId("edit-identity-header")).toBeNull();
    // The standalone button row still renders.
    expect(screen.getByTestId("edit-history-link")).toBeTruthy();
  });
});
