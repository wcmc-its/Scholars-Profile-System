/**
 * #955 — the `/edit` shell surfaces a "View change history" entry link beside
 * the "Preview Profile" link, wired to `/edit/scholar/[cwid]/history`. The link
 * shows in every edit mode (history visibility == edit access) and, being an
 * internal page, opens in the same tab (no `target=_blank`, no external arrow).
 *
 * `AccountMenu` is a client component that fires an impersonation-probe fetch on
 * mount, so it's mocked out — this suite only exercises the shell's link row.
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
  mode: "self" as const,
  scholarName: "Jane Doe",
  railItems: [],
  activeAttr: "overview",
  basePath: "/edit",
};

describe("EditShell — change-history entry link (#955)", () => {
  it("renders 'View change history' pointing at the internal history page (same tab)", () => {
    render(
      <EditShell {...base} historyHref="/edit/scholar/abc1001/history">
        <div>panel</div>
      </EditShell>,
    );
    const link = screen.getByTestId("edit-history-link");
    expect(link.getAttribute("href")).toBe("/edit/scholar/abc1001/history");
    expect(link.textContent).toContain("View change history");
    // Internal — no new-tab / external semantics (unlike Preview Profile).
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("rel")).toBeNull();
  });

  it("still renders the Preview link, and omits history when no historyHref", () => {
    render(
      <EditShell {...base} previewHref="https://example.test/jane">
        <div>panel</div>
      </EditShell>,
    );
    expect(screen.queryByTestId("edit-history-link")).toBeNull();
    const preview = screen.getByRole("link", { name: /Preview Profile/ });
    expect(preview.getAttribute("href")).toBe("https://example.test/jane");
    expect(preview.getAttribute("target")).toBe("_blank");
  });
});
