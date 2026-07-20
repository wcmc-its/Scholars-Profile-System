/**
 * `components/edit/console-shell.tsx` — the shared chrome for the /edit console
 * list/queue pages (console-shell-migration-plan.md). Asserts the shell wiring:
 * the warm-page shell, ONE console-variant top bar (no second <h1>, no in-bar
 * account menu / Sign out), the correct AdminSubnav `active`, the `#console-main`
 * region, and the role-gated tab set for a superuser vs a comms_steward.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { EditSession } from "@/lib/auth/superuser";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// The AdminSubnav strip mounts the real AccountMenu (a client island probing
// /api/auth/session) at its right end — stub it so the shell renders without a
// live fetch. Its presence here is what makes the top bar deliberately menu-free.
vi.mock("@/components/site/account-menu", () => ({
  AccountMenu: ({ context }: { context?: string }) => (
    <div data-testid="account-menu-stub" data-context={context} />
  ),
}));

import { ConsoleShell } from "@/components/edit/console-shell";

function session(overrides: Partial<EditSession>): EditSession {
  return { cwid: "aaa0001", isSuperuser: false, isCommsSteward: false, ...overrides };
}

describe("ConsoleShell", () => {
  beforeEach(() => {
    vi.stubEnv("SELF_EDIT_ADMINISTRATORS_TAB", "on");
    vi.stubEnv("COMMS_STEWARD_ENABLED", "on");
    vi.stubEnv("EDIT_DATA_QUALITY_DASHBOARD", "on");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the shell chrome once, with the page's <h1> the only h1", () => {
    const { container } = render(
      <ConsoleShell
        active="activity"
        session={session({ isSuperuser: true })}
        pendingSlugRequests={null}
        pendingHonors={null}
      >
        <h1>Edit activity</h1>
      </ConsoleShell>,
    );

    // Warm-page shell + a skip link into the main region.
    expect(container.querySelector(".bg-apollo-page")).toBeTruthy();
    expect(screen.getByText("Skip to content").getAttribute("href")).toBe("#console-main");

    // The console-variant top bar: the console name is a NON-heading span, so the
    // page's own <h1> is the ONLY h1 — no double-heading.
    const title = screen.getByText("Scholars Profile Console");
    expect(title.tagName).toBe("SPAN");
    const h1s = container.querySelectorAll("h1");
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe("Edit activity");

    // No in-bar account menu / Sign out — the account menu lives in the subnav.
    expect(screen.queryByTestId("edit-signout")).toBeNull();
    expect(screen.getByTestId("account-menu-stub").getAttribute("data-context")).toBe("console");

    // The active tab is marked; the main region is present.
    expect(screen.getByTestId("admin-tab-activity").getAttribute("aria-current")).toBe("page");
    const main = container.querySelector("#console-main");
    expect(main?.tagName).toBe("MAIN");
  });

  it("superuser sees the superuser strip (Administrators / URL registry / Activity / Usage)", () => {
    render(
      <ConsoleShell
        active="activity"
        session={session({ isSuperuser: true })}
        pendingSlugRequests={null}
        pendingHonors={null}
      >
        <h1>Edit activity</h1>
      </ConsoleShell>,
    );
    expect(screen.getByTestId("admin-tab-administrators")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-slugs")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-activity")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-usage")).toBeTruthy();
  });

  it("comms_steward sees Profiles + Units + Methods, NOT the superuser-only surfaces", () => {
    render(
      <ConsoleShell
        active="methods"
        session={session({ isCommsSteward: true })}
        pendingSlugRequests={null}
        pendingHonors={null}
      >
        <h1>Method families</h1>
      </ConsoleShell>,
    );
    expect(screen.getByTestId("admin-tab-profiles")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-units")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-methods")).toBeTruthy();
    // Superuser-only surfaces stay hidden.
    expect(screen.queryByTestId("admin-tab-slugs")).toBeNull();
    expect(screen.queryByTestId("admin-tab-administrators")).toBeNull();
    expect(screen.queryByTestId("admin-tab-activity")).toBeNull();
  });
});
