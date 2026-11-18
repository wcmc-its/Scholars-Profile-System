/**
 * The profile Contact-card island. Session and on-campus (network) viewers both
 * get the address on mount; an external viewer, or a `none` release, gets
 * nothing, including no empty card.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { ContactEmailReveal } from "@/components/profile/contact-email-reveal";

const EMAIL = "person@med.cornell.edu";

function mockFetch(body: unknown) {
  const fn = vi.fn(async () => ({ ok: true, json: async () => body }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ContactEmailReveal", () => {
  it.each(["session", "network"])("%s viewer → address on mount, no button", async (viewer) => {
    mockFetch({ email: EMAIL, viewer });
    render(<ContactEmailReveal cwid="p001" mode="card" />);
    const link = await screen.findByText(EMAIL);
    expect(link.getAttribute("href")).toBe(`mailto:${EMAIL}`);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("external / none → renders nothing (no empty card)", async () => {
    const fetchFn = mockFetch({ email: null, viewer: "external" });
    const { container } = render(<ContactEmailReveal cwid="p001" mode="card" />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
