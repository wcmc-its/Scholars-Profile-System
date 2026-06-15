/**
 * `components/search/autocomplete.tsx` — submit routing, the "pending" search
 * affordance (useTransition + Loader2 spinner + aria-busy + sr-only "Searching"
 * status + a disabled hero Search button), and the on-/search URL context
 * (preserving the active `&type=` tab on a new search + pre-filling the box
 * with the current query, both read from `window.location`).
 *
 * The suggest `useEffect` fires `fetch` on >=2 chars; we stub it to resolve an
 * empty suggestion set so it never throws. The pending affordance is forced
 * deterministically by mocking React's `useTransition` (the `h.pending` flag),
 * which also makes `startTransition` run its callback synchronously so the
 * submit/router.push assertions stay green.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// Force pending state deterministically. `h.pending` toggles isPending; the
// synchronous `(cb) => cb()` makes startTransition run its callback inline so
// router.push fires within the test tick.
const h = vi.hoisted(() => ({ pending: false }));
vi.mock("react", async (orig) => {
  const actual = (await orig()) as typeof import("react");
  return { ...actual, useTransition: () => [h.pending, (cb: () => void) => cb()] };
});

import { SearchAutocomplete } from "@/components/search/autocomplete";

beforeEach(() => {
  h.pending = false;
  pushMock.mockClear();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ suggestions: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SearchAutocomplete — submit routing", () => {
  it("typing a term and pressing Enter pushes the URL-encoded /search query", () => {
    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/search?q=cancer");
  });

  it("hero variant: clicking the Search button pushes the same URL shape", () => {
    render(<SearchAutocomplete variant="hero" />);
    fireEvent.change(screen.getByLabelText("Search scholars"), { target: { value: "cancer" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(pushMock).toHaveBeenCalledWith("/search?q=cancer");
  });

  it("URL-encodes the query (whitespace/punctuation) on submit", () => {
    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "gene therapy" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/search?q=gene%20therapy");
  });

  it("empty submit is a no-op (router.push not called)", () => {
    render(<SearchAutocomplete />);
    fireEvent.keyDown(screen.getByLabelText("Search scholars"), { key: "Enter" });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("whitespace-only submit is a no-op (router.push not called)", () => {
    render(<SearchAutocomplete variant="hero" />);
    fireEvent.change(screen.getByLabelText("Search scholars"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("SearchAutocomplete — pending affordance", () => {
  it("default (not pending): aria-busy is falsy and the leading Search icon renders (no spinner)", () => {
    const { container } = render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    // jsdom serializes aria-busy={false} to either absent or "false".
    expect(input.getAttribute("aria-busy")).not.toBe("true");
    // Leading Search icon present, spinner absent.
    expect(container.querySelector("svg.lucide-search")).toBeTruthy();
    expect(container.querySelector("svg.animate-spin")).toBeNull();
    // sr-only status is empty.
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("pending: spinner renders, input is aria-busy, status reads Searching", () => {
    h.pending = true;
    const { container } = render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    expect(input.getAttribute("aria-busy")).toBe("true");
    // Spinner replaces the leading Search icon.
    expect(container.querySelector("svg.animate-spin")).toBeTruthy();
    expect(container.querySelector("svg.lucide-search")).toBeNull();
    // sr-only live region announces progress.
    expect(screen.getByRole("status").textContent).toContain("Searching");
  });

  it("pending hero: the Search button is disabled", () => {
    h.pending = true;
    render(<SearchAutocomplete variant="hero" />);
    expect((screen.getByRole("button", { name: "Search" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SearchAutocomplete — URL context (type preservation + query pre-fill)", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    vi.useRealTimers();
  });

  it("preserves the active &type= tab on a new search from /search", () => {
    window.history.replaceState(null, "", "/search?q=hiv&type=publications");
    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/search?q=cancer&type=publications");
  });

  it("does not append type when the active tab is the people default", () => {
    window.history.replaceState(null, "", "/search?q=hiv&type=people");
    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/search?q=cancer");
  });

  it("does not preserve type when submitting from a non-/search page", () => {
    window.history.replaceState(null, "", "/scholars/jane-doe?type=publications");
    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "cancer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/search?q=cancer");
  });

  it("pre-fills the box with the active query when landing on /search", () => {
    window.history.replaceState(null, "", "/search?q=real-world%20evidence&type=publications");
    render(<SearchAutocomplete />);
    expect((screen.getByLabelText("Search scholars") as HTMLInputElement).value).toBe(
      "real-world evidence",
    );
  });

  it("does not pre-fill on a non-/search page", () => {
    window.history.replaceState(null, "", "/?q=cancer");
    render(<SearchAutocomplete />);
    expect((screen.getByLabelText("Search scholars") as HTMLInputElement).value).toBe("");
  });

  it("the pre-fill does not fire a suggest fetch or open the dropdown", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/search?q=cancer");
    render(<SearchAutocomplete />);
    // Advance past the 150ms suggest debounce: with the skip guard the effect
    // early-returned, so no timer was scheduled and no fetch fires.
    await vi.advanceTimersByTimeAsync(300);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
