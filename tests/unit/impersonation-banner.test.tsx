/**
 * `components/site/impersonation-banner.tsx` — the one-line "View as" bar
 * (Front page tweaks mockup, 2026-09-30). The target's role links moved to the
 * account menu (`account-menu.test.tsx`, "while viewing as").
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { ImpersonationBanner } from "@/components/site/impersonation-banner";

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubProbe(impersonating: Record<string, unknown> | null) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        authenticated: true,
        scholar: { slug: "paul-albert", preferredName: "Paul Albert" },
        impersonating,
        canImpersonate: true,
        isSuperuser: true,
        consoleLinks: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

describe("ImpersonationBanner", () => {
  it("names the target and logs edits to the REAL user (never 'made as Paul')", async () => {
    stubProbe({
      targetCwid: "own001",
      targetName: "Terrie Rose Wheeler",
      role: "curator",
      unitKind: "department",
      unit: "Library",
      startedAt: Math.floor(Date.now() / 1000),
    });
    render(<ImpersonationBanner />);

    const banner = await screen.findByTestId("impersonation-banner");
    expect(banner.textContent).toContain("Viewing as Terrie Rose Wheeler · Curator · Library (Dept)");
    expect(banner.textContent).toContain("Edits logged to Paul Albert");
    expect(banner.textContent).not.toContain("made as Paul");
    // The role links live in the account menu now, not the bar.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders nothing when there is no live overlay", async () => {
    const fetchMock = stubProbe(null);
    render(<ImpersonationBanner />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("impersonation-banner")).toBeNull();
  });
});
