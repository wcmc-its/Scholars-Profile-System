import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { EditMyProfileButton } from "@/components/scholar/edit-my-profile-button";

/** Stub global fetch so the client-side /api/auth/session probe is deterministic. */
function stubSessionProbe(
  body: {
    authenticated?: boolean;
    scholar?: { slug: string } | null;
    canImpersonate?: boolean;
  },
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
  // Default: anonymous viewer — neither owner nor superuser.
  stubSessionProbe({ authenticated: false, scholar: null, canImpersonate: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EditMyProfileButton — owner", () => {
  it("renders 'Edit my profile' → /edit when the signed-in slug matches", async () => {
    stubSessionProbe({ authenticated: true, scholar: { slug: "jane-smith" } });
    render(<EditMyProfileButton profileSlug="jane-smith" profileCwid="jas2001" />);

    const link = (await screen.findByTestId("edit-my-profile")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/edit");
    expect(link.textContent).toBe("Edit my profile");
    // Never the superuser deep-link on one's own profile.
    expect(screen.queryByTestId("edit-profile-superuser")).toBeNull();
  });
});

describe("EditMyProfileButton — superuser deep-link (#955)", () => {
  it("renders 'Edit profile' → /edit/scholar/<cwid> when canImpersonate is true", async () => {
    stubSessionProbe({
      authenticated: true,
      scholar: { slug: "sue-admin" },
      canImpersonate: true,
    });
    render(<EditMyProfileButton profileSlug="jane-smith" profileCwid="jas2001" />);

    const link = (await screen.findByTestId("edit-profile-superuser")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/edit/scholar/jas2001");
    expect(link.textContent).toBe("Edit profile");
    // Not the owner link — the superuser is viewing someone else's page.
    expect(screen.queryByTestId("edit-my-profile")).toBeNull();
  });

  it("encodes the cwid in the href", async () => {
    stubSessionProbe({
      authenticated: true,
      scholar: { slug: "sue-admin" },
      canImpersonate: true,
    });
    render(<EditMyProfileButton profileSlug="jane-smith" profileCwid="a b/c" />);

    const link = (await screen.findByTestId("edit-profile-superuser")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`/edit/scholar/${encodeURIComponent("a b/c")}`);
  });

  it("owner wins: a superuser on their OWN profile gets /edit, not the deep-link", async () => {
    stubSessionProbe({
      authenticated: true,
      scholar: { slug: "sue-admin" },
      canImpersonate: true,
    });
    render(<EditMyProfileButton profileSlug="sue-admin" profileCwid="sue9001" />);

    const link = (await screen.findByTestId("edit-my-profile")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/edit");
    expect(screen.queryByTestId("edit-profile-superuser")).toBeNull();
  });
});

describe("EditMyProfileButton — hidden for everyone else", () => {
  it("renders nothing for a non-superuser viewing someone else's profile", async () => {
    stubSessionProbe({
      authenticated: true,
      scholar: { slug: "someone-else" },
      canImpersonate: false,
    });
    const { container } = render(
      <EditMyProfileButton profileSlug="jane-smith" profileCwid="jas2001" />,
    );

    // Give the probe a tick to resolve, then assert nothing rendered.
    await waitFor(() => {
      expect(screen.queryByTestId("edit-my-profile")).toBeNull();
      expect(screen.queryByTestId("edit-profile-superuser")).toBeNull();
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for an anonymous viewer (probe reports signed out)", async () => {
    const { container } = render(
      <EditMyProfileButton profileSlug="jane-smith" profileCwid="jas2001" />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("edit-my-profile")).toBeNull();
      expect(screen.queryByTestId("edit-profile-superuser")).toBeNull();
    });
    expect(container.firstChild).toBeNull();
  });

  it("fails closed (hidden) when the probe rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const { container } = render(
      <EditMyProfileButton profileSlug="jane-smith" profileCwid="jas2001" />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("edit-profile-superuser")).toBeNull();
    });
    expect(container.firstChild).toBeNull();
  });
});
