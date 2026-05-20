import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock next/navigation before importing the component.
const mockUsePathname = vi.fn();
const mockUseSearchParams = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
  useSearchParams: () => mockUseSearchParams(),
}));

import { HeaderAuthSlot } from "@/components/site/header-auth-slot";

beforeEach(() => {
  mockUsePathname.mockReset();
  mockUseSearchParams.mockReset();
  // Default: behave as if on a plain path with no query.
  mockUsePathname.mockReturnValue("/");
  mockUseSearchParams.mockReturnValue(new URLSearchParams(""));
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

  it("preserves the current query string in the return parameter", () => {
    mockUsePathname.mockReturnValue("/search");
    mockUseSearchParams.mockReturnValue(new URLSearchParams("q=mRNA&page=2"));
    render(<HeaderAuthSlot isAuthenticated={false} scholar={null} />);

    const link = screen.getByTestId("header-sign-in") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "/api/auth/saml/login?return=" + encodeURIComponent("/search?q=mRNA&page=2"),
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
