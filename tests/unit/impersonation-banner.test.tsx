/**
 * `components/site/impersonation-banner.tsx` — the "Can access" role-links
 * line (2026-08-19). Covers that the banner picks the right fixed
 * destination(s) per `SubjectRole`, since `ROLE_LINKS` is the one place that
 * policy lives and a missing/wrong entry is otherwise silent (no server round
 * trip to fail loudly).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { ImpersonationBanner } from "@/components/site/impersonation-banner";

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubProbe(impersonating: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        authenticated: true,
        scholar: { slug: "paul-albert", preferredName: "Paul Albert" },
        impersonating,
        canImpersonate: true,
        consoleLinks: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

describe("ImpersonationBanner role links", () => {
  it("links a search-blind global role (development) straight to its one console page", async () => {
    stubProbe({
      targetCwid: "lmp2006",
      targetName: "lmp2006",
      role: "development",
      unitKind: null,
      unit: null,
      startedAt: Math.floor(Date.now() / 1000),
    });
    render(<ImpersonationBanner />);

    await screen.findByTestId("impersonation-role-links");
    const link = screen.getByRole("link", { name: "Grant Matcha" });
    expect(link.getAttribute("href")).toBe("/edit/grant-matcha");
  });

  it("gives a unit owner both of the same two links a non-superuser unit admin gets", async () => {
    stubProbe({
      targetCwid: "own001",
      targetName: "Jane Owner",
      role: "owner",
      unitKind: "department",
      unit: "Cardiology",
      startedAt: Math.floor(Date.now() / 1000),
    });
    render(<ImpersonationBanner />);

    const profiles = await screen.findByRole("link", { name: "Profiles" });
    expect(profiles.getAttribute("href")).toBe("/edit/scholars");
    const units = screen.getByRole("link", { name: "Org units" });
    expect(units.getAttribute("href")).toBe("/edit/units");
  });

  it("sends a plain scholar to their own self-edit surface", async () => {
    stubProbe({
      targetCwid: "sch001",
      targetName: "Jane Scholar",
      role: "scholar",
      unitKind: null,
      unit: null,
      startedAt: Math.floor(Date.now() / 1000),
    });
    render(<ImpersonationBanner />);

    const link = await screen.findByRole("link", { name: "Their profile" });
    expect(link.getAttribute("href")).toBe("/edit");
  });

  it("renders nothing (no role-links line) when there is no live overlay", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticated: true,
          scholar: { slug: "paul-albert", preferredName: "Paul Albert" },
          impersonating: null,
          canImpersonate: true,
          consoleLinks: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<ImpersonationBanner />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("impersonation-banner")).toBeNull();
  });
});
