/**
 * `ReciterPendingCardClient` — the client loader that lazily fetches the self
 * viewer's live ReCiter pending suggestions from `/api/edit/reciter-pending` on
 * mount and renders the presentational {@link ReciterPendingCard} only when
 * populated.
 *
 * Verifies: it fetches the self-only endpoint once on mount; it renders the card
 * (the hero) when the route returns suggestions; it renders nothing while empty;
 * and it degrades to nothing (never throws) on a non-2xx or a network error.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { ReciterPendingCardClient } from "@/components/edit/reciter-pending-card";

const HERO = {
  pmid: "39000001",
  score: 88,
  articleTitle: "A high-confidence candidate paper",
  authors: "Self A, Coauthor B",
  journal: "Nature",
  datePublished: "2025 May 28",
  isPreprint: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReciterPendingCardClient — lazy self-only loader", () => {
  it("fetches /api/edit/reciter-pending once on mount and renders the card when populated", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [HERO] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReciterPendingCardClient />);

    await waitFor(() => expect(screen.getByTestId("reciter-pending-bridge")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/reciter-pending");
    expect(screen.getByTestId("reciter-pending-hero").textContent).toContain(
      "A high-confidence candidate paper",
    );
  });

  it("renders nothing when the route returns an empty list", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<ReciterPendingCardClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("reciter-pending-bridge")).toBeNull();
  });

  it("renders nothing (never throws) on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<ReciterPendingCardClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing (never throws) on a network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<ReciterPendingCardClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });
});
