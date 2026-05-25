import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Mock next/navigation before importing the component.
const mockUsePathname = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

import { HeaderAuthSlot } from "@/components/site/header-auth-slot";

/** Stub global fetch so the client-side /api/auth/session probe is deterministic. */
function stubSessionProbe(
  body: { authenticated: boolean; scholar?: { slug: string; preferredName: string } | null },
  ok = true,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      json: () => Promise.resolve(body),
    } as Response),
  );
}

beforeEach(() => {
  mockUsePathname.mockReset();
  mockUsePathname.mockReturnValue("/");
  // Default: the probe reports signed-out (the common anonymous case).
  stubSessionProbe({ authenticated: false, scholar: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HeaderAuthSlot — signed out", () => {
  it("renders a Sign in link to /api/auth/saml/login with ?return={pathname}", async () => {
    mockUsePathname.mockReturnValue("/scholars/jane-smith");
    render(<HeaderAuthSlot isAuthenticated={false} scholar={null} />);

    const link = (await screen.findByTestId("header-sign-in")) as HTMLAnchorElement;
    expect(link.textContent).toBe("Sign in");
    expect(link.getAttribute("href")).toBe(
      "/api/auth/saml/login?return=" + encodeURIComponent("/scholars/jane-smith"),
    );
  });

  it("does NOT carry a query string in the return parameter (path-only by design)", async () => {
    mockUsePathname.mockReturnValue("/search");
    render(<HeaderAuthSlot isAuthenticated={false} scholar={null} />);
    const link = (await screen.findByTestId("header-sign-in")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "/api/auth/saml/login?return=" + encodeURIComponent("/search"),
    );
  });

  it("does not render the account menu when the probe also reports signed out", async () => {
    render(<HeaderAuthSlot isAuthenticated={false} scholar={null} />);
    await screen.findByTestId("header-sign-in");
    expect(screen.queryByLabelText("Account menu")).toBeNull();
  });
});

describe("HeaderAuthSlot — signed in (server prop, cookie-forwarding surface)", () => {
  it("renders the AccountMenu trigger with the scholar's preferredName", () => {
    render(
      <HeaderAuthSlot
        isAuthenticated
        scholar={{ slug: "jane-smith", preferredName: "Jane Smith" }}
      />,
    );
    expect(screen.queryByTestId("header-sign-in")).toBeNull();
    expect(screen.getByLabelText("Account menu")).toBeTruthy();
    expect(screen.getByText("Jane Smith")).toBeTruthy();
  });

  it("renders the AccountMenu with the no-scholar fallback (D5.3)", () => {
    render(<HeaderAuthSlot isAuthenticated scholar={null} />);
    expect(screen.getByLabelText("Account menu")).toBeTruthy();
    expect(screen.getByText("Account")).toBeTruthy();
  });

  it("skips the probe when the server prop already says authenticated", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<HeaderAuthSlot isAuthenticated scholar={null} />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("HeaderAuthSlot — cached public page correction (#356 / CloudFront cookie-strip)", () => {
  it("upgrades to the AccountMenu when the server prop is false but /api/auth/session reports signed in", async () => {
    // The cached-page case: the origin never saw the cookie, so the server
    // prop is false, but the client probe (cookie-forwarding path) confirms
    // the real session.
    stubSessionProbe({
      authenticated: true,
      scholar: { slug: "jane-smith", preferredName: "Jane Smith" },
    });
    render(<HeaderAuthSlot isAuthenticated={false} scholar={null} />);

    // Initially the Sign in link (server prop) ...
    expect(screen.getByTestId("header-sign-in")).toBeTruthy();
    // ... then the probe resolves and the AccountMenu replaces it.
    await waitFor(() => expect(screen.getByLabelText("Account menu")).toBeTruthy());
    expect(screen.queryByTestId("header-sign-in")).toBeNull();
    expect(screen.getByText("Jane Smith")).toBeTruthy();
  });

  it("stays signed-out if the probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    render(<HeaderAuthSlot isAuthenticated={false} scholar={null} />);
    await screen.findByTestId("header-sign-in");
    expect(screen.queryByLabelText("Account menu")).toBeNull();
  });
});
