/**
 * `components/edit/slug-availability-checker.tsx` — the registry's "is this slug
 * available?" client island (#497). Tests the fetch call shape and each verdict
 * render (available / reserved / live / override / history / invalid / error).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

import { SlugAvailabilityChecker } from "@/components/edit/slug-availability-checker";
import type { SlugStatus } from "@/lib/api/slug-registry";

function mockFetchStatus(status: SlugStatus) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, status }),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function submit(value: string) {
  fireEvent.change(screen.getByTestId("slug-check-input"), { target: { value } });
  // Wrap the click in act + a microtask flush so the fetch promise's state
  // update settles inside an act() boundary (no act(...) warning).
  await act(async () => {
    fireEvent.click(screen.getByTestId("slug-check-submit"));
    await Promise.resolve();
  });
}

describe("SlugAvailabilityChecker", () => {
  it("calls GET /api/edit/slugs with the encoded slug and shows 'available'", async () => {
    const fetchMock = mockFetchStatus({ state: "available", slug: "brand-new" });
    vi.stubGlobal("fetch", fetchMock);
    render(<SlugAvailabilityChecker />);
    await submit("brand new");
    await waitFor(() => screen.getByTestId("slug-check-result"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/edit/slugs?slug=brand%20new",
      expect.objectContaining({ headers: expect.anything() }),
    );
    expect(screen.getByTestId("slug-check-result").textContent).toMatch(/available/i);
  });

  it("the submit button is disabled with an empty input", () => {
    render(<SlugAvailabilityChecker />);
    expect((screen.getByTestId("slug-check-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the reserved verdict", async () => {
    vi.stubGlobal("fetch", mockFetchStatus({ state: "reserved", slug: "about" }));
    render(<SlugAvailabilityChecker />);
    await submit("about");
    await waitFor(() => screen.getByTestId("slug-check-result"));
    expect(screen.getByTestId("slug-check-result").textContent).toMatch(/reserved route word/i);
  });

  it("renders the live-holder verdict with name + cwid", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchStatus({ state: "taken", slug: "jane-smith", held: "live", cwid: "js1", name: "Jane Smith" }),
    );
    render(<SlugAvailabilityChecker />);
    await submit("jane-smith");
    await waitFor(() => screen.getByTestId("slug-check-result"));
    const txt = screen.getByTestId("slug-check-result").textContent ?? "";
    expect(txt).toMatch(/Jane Smith/);
    expect(txt).toMatch(/js1/);
  });

  it("renders the override verdict", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchStatus({ state: "taken", slug: "pinned", held: "override", cwid: "h7" }),
    );
    render(<SlugAvailabilityChecker />);
    await submit("pinned");
    await waitFor(() => screen.getByTestId("slug-check-result"));
    expect(screen.getByTestId("slug-check-result").textContent).toMatch(/pinned by an override for h7/i);
  });

  it("renders the history verdict (breaks the redirect)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchStatus({ state: "taken", slug: "old-slug", held: "history", currentCwid: "c9", currentSlug: "new-slug" }),
    );
    render(<SlugAvailabilityChecker />);
    await submit("old-slug");
    await waitFor(() => screen.getByTestId("slug-check-result"));
    const txt = screen.getByTestId("slug-check-result").textContent ?? "";
    expect(txt).toMatch(/former slug of new-slug/i);
    expect(txt).toMatch(/break that redirect/i);
  });

  it("renders the invalid verdict", async () => {
    vi.stubGlobal("fetch", mockFetchStatus({ state: "invalid", reason: "format" }));
    render(<SlugAvailabilityChecker />);
    await submit("Bad Slug!");
    await waitFor(() => screen.getByTestId("slug-check-result"));
    expect(screen.getByTestId("slug-check-result").textContent).toMatch(/invalid shape/i);
  });

  it("shows an error alert when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ ok: false }) }));
    render(<SlugAvailabilityChecker />);
    await submit("anything");
    await waitFor(() => screen.getByTestId("slug-check-error"));
    expect(screen.getByTestId("slug-check-error").textContent).toMatch(/couldn't check/i);
  });

  it("shows an error alert when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    render(<SlugAvailabilityChecker />);
    await submit("anything");
    await waitFor(() => screen.getByTestId("slug-check-error"));
    expect(screen.getByTestId("slug-check-error")).toBeTruthy();
  });
});
