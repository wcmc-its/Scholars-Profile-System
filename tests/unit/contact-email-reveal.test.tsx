/**
 * Crawler hardening (2026-11-09 institution-email-reveal spec) — the profile
 * Contact-card island.
 *
 * LOAD-BEARING: "network viewer → no ?reveal=1 fetch until click". A JS-rendering
 * indexer on the WCM network renders but never clicks; if the island sent
 * `?reveal=1` on mount the address would land in its index. Mutate the mount
 * effect to pass `reveal: true` and this file must go red.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ContactEmailReveal } from "@/components/profile/contact-email-reveal";

const EMAIL = "person@med.cornell.edu";

function mockFetch(handler: (url: string) => unknown) {
  const fn = vi.fn(async (url: string) => ({ ok: true, json: async () => handler(url) }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ContactEmailReveal", () => {
  it("session viewer → address on mount, no button", async () => {
    mockFetch(() => ({ email: EMAIL, viewer: "session" }));
    render(<ContactEmailReveal cwid="p001" mode="card" />);
    expect(await screen.findByText(EMAIL)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /show email/i })).toBeNull();
  });

  it("network viewer → button only; no ?reveal=1 fetch until click", async () => {
    const fetchFn = mockFetch((url) =>
      url.includes("reveal=1")
        ? { email: EMAIL, viewer: "network" }
        : { email: null, viewer: "network", revealable: true },
    );
    render(<ContactEmailReveal cwid="p001" mode="card" />);
    const btn = await screen.findByRole("button", { name: /show email/i });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).not.toContain("reveal=1");
    expect(screen.queryByText(EMAIL)).toBeNull();

    fireEvent.click(btn);
    expect(await screen.findByText(EMAIL)).toBeTruthy();
    expect(fetchFn.mock.calls[1][0]).toContain("reveal=1");
    expect(screen.queryByRole("button", { name: /show email/i })).toBeNull();
  });

  it("external / none → renders nothing (no empty card)", async () => {
    const fetchFn = mockFetch(() => ({ email: null, viewer: "external" }));
    const { container } = render(<ContactEmailReveal cwid="p001" mode="card" />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("click that yields no address → button goes away (fail-closed)", async () => {
    mockFetch((url) =>
      url.includes("reveal=1")
        ? { email: null, viewer: "network" }
        : { email: null, viewer: "network", revealable: true },
    );
    const { container } = render(<ContactEmailReveal cwid="p001" mode="li" />);
    fireEvent.click(await screen.findByRole("button", { name: /show email/i }));
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});
