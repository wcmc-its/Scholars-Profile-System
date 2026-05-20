import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock next/navigation before importing the component.
const mockUsePathname = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

import { HeaderAuthSlot } from "@/components/site/header-auth-slot";

beforeEach(() => {
  mockUsePathname.mockReset();
  mockUsePathname.mockReturnValue("/");
});

describe("HeaderAuthSlot — signed out", () => {
  it("renders a Sign in link to /api/auth/saml/login with ?return={pathname}", () => {
    mockUsePathname.mockReturnValue("/scholars/jane-smith");
    render(<HeaderAuthSlot isAuthenticated={false} scholar={null} />);

    const link = screen.getByTestId("header-sign-in") as HTMLAnchorElement;
    expect(link.textContent).toBe("Sign in");
    expect(link.getAttribute("href")).toBe(
      "/api/auth/saml/login?return=" + encodeURIComponent("/scholars/jane-smith"),
    );
  });

  it("does NOT carry a query string in the return parameter (path-only by design)", () => {
    // Per the component's JSDoc: useSearchParams() would force a Suspense
    // boundary, breaking next build's prerender of `/`. Path is the unit.
    mockUsePathname.mockReturnValue("/search");
    render(<HeaderAuthSlot isAuthenticated={false} scholar={null} />);
    const link = screen.getByTestId("header-sign-in") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "/api/auth/saml/login?return=" + encodeURIComponent("/search"),
    );
  });

  it("does not render the account menu when signed out", () => {
    render(<HeaderAuthSlot isAuthenticated={false} scholar={null} />);
    expect(screen.queryByLabelText("Account menu")).toBeNull();
  });
});

describe("HeaderAuthSlot — signed in", () => {
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
});
