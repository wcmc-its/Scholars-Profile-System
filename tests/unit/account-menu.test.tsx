import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { AccountMenu } from "@/components/site/account-menu";

describe("AccountMenu — with a scholar row", () => {
  const scholar = { slug: "jane-smith", preferredName: "Jane Smith" };

  it("renders the scholar's preferredName as the trigger label", () => {
    render(<AccountMenu scholar={scholar} />);
    expect(screen.getByLabelText("Account menu")).toBeTruthy();
    expect(screen.getByText("Jane Smith")).toBeTruthy();
  });

  it("on open, surfaces Edit / View / Sign out (the full three-item menu + separator)", () => {
    render(<AccountMenu scholar={scholar} />);
    fireEvent.click(screen.getByLabelText("Account menu"));

    const edit = screen.getByTestId("account-menu-edit");
    expect(edit.getAttribute("href")).toBe("/edit");
    expect(edit.textContent).toBe("Edit my profile");

    const view = screen.getByTestId("account-menu-view");
    // #671 — profile links use the root `/{slug}` form (profilePath).
    expect(view.getAttribute("href")).toBe("/jane-smith");
    expect(view.textContent).toBe("View my profile");

    const signout = screen.getByTestId("account-menu-signout");
    expect(signout.textContent).toBe("Sign out");
    expect(signout.closest("form")?.getAttribute("action")).toBe("/api/auth/logout");
    expect(signout.closest("form")?.getAttribute("method")?.toLowerCase()).toBe("post");

    // The Separator is rendered between View and Sign out (data-slot from separator.tsx).
    expect(document.querySelector('[data-slot="separator"]')).toBeTruthy();
  });
});

describe("AccountMenu — without a scholar row (D5.3)", () => {
  it("falls back to 'Account' as the trigger label", () => {
    render(<AccountMenu scholar={null} />);
    expect(screen.getByText("Account")).toBeTruthy();
  });

  it("on open, surfaces ONLY Sign out — no Edit / View / Separator", () => {
    render(<AccountMenu scholar={null} />);
    fireEvent.click(screen.getByLabelText("Account menu"));

    expect(screen.queryByTestId("account-menu-edit")).toBeNull();
    expect(screen.queryByTestId("account-menu-view")).toBeNull();
    expect(document.querySelector('[data-slot="separator"]')).toBeNull();

    const signout = screen.getByTestId("account-menu-signout");
    expect(signout.textContent).toBe("Sign out");
    expect(signout.closest("form")?.getAttribute("action")).toBe("/api/auth/logout");
  });
});
