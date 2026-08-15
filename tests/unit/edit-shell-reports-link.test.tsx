/**
 * Reports IA redesign (2026-08-14) — the center editor's header surfaces a
 * "View reports" entry link beside "Preview Profile" / "View change history",
 * wired to `/edit/reports?center=...`. Replaces the earlier rail-mounted
 * `CenterReportsRailLink` so the link survives the roster/Members page
 * (`hideRail`), which the row already does — this only exercises the new
 * `reportsHref` slot itself. Internal page, so same tab (no `target=_blank`,
 * no external arrow) — unlike Preview Profile.
 *
 * `AccountMenu` is a client component that fires an impersonation-probe fetch on
 * mount, so it's mocked out — this suite only exercises the shell's link row.
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
  mode: "self" as const,
  scholarName: "Meyer Cancer Center",
  railItems: [],
  activeAttr: "description",
  basePath: "/edit/center/meyer",
};

describe("EditShell — reports entry link (Reports IA redesign)", () => {
  it("renders 'View reports' pointing at the reports console (same tab)", () => {
    render(
      <EditShell {...base} reportsHref="/edit/reports?center=meyer">
        <div>panel</div>
      </EditShell>,
    );
    const link = screen.getByTestId("edit-reports-link");
    expect(link.getAttribute("href")).toBe("/edit/reports?center=meyer");
    expect(link.textContent).toContain("View reports");
    // Internal — no new-tab / external semantics (unlike Preview Profile).
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("rel")).toBeNull();
  });

  it("omits the reports link when no reportsHref, without affecting the other two", () => {
    render(
      <EditShell
        {...base}
        historyHref="/edit/scholar/abc1001/history"
        previewHref="https://example.test/meyer"
      >
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.queryByTestId("edit-reports-link")).toBeNull();
    expect(screen.getByTestId("edit-history-link")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Preview Profile/ })).toBeTruthy();
  });

  it("renders alongside history and preview when all three are supplied", () => {
    render(
      <EditShell
        {...base}
        historyHref="/edit/scholar/abc1001/history"
        previewHref="https://example.test/meyer"
        reportsHref="/edit/reports?center=meyer"
      >
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.getByTestId("edit-history-link")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Preview Profile/ })).toBeTruthy();
    expect(screen.getByTestId("edit-reports-link")).toBeTruthy();
  });
});
