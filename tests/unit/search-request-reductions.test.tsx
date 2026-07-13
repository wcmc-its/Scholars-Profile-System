/**
 * #1412 item 4 — the suggest path had a 150ms debounce and an AbortController, so it
 * never had two requests in flight at once. But nothing remembered a settled answer:
 * backspacing through a typed query re-fetched every prefix on the way back. A prefix
 * the user already resolved is now served from a module-scoped cache.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { SearchAutocomplete } from "@/components/search/autocomplete";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("#1412 item 4 — suggest caches resolved prefixes", () => {
  it("backspacing onto an already-resolved prefix issues no new request", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ suggestions: [] }) });
    vi.stubGlobal("fetch", fetchFn);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<SearchAutocomplete />);
    const input = screen.getByRole("combobox");
    const type = (v: string) => fireEvent.change(input, { target: { value: v } });

    // Type a prefix; let the debounce fire and the response settle.
    type("zebrafish");
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    // Extend it — a distinct prefix, so a second request is correct.
    type("zebrafish h");
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));

    // Backspace back onto the first prefix: served from cache, no third request.
    type("zebrafish");
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
