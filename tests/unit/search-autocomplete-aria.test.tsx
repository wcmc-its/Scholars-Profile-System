/**
 * `components/search/autocomplete.tsx` — WAI-ARIA 1.2 combobox contract
 * (2026-07-07 review fix). The listbox/option roles existed and ArrowUp/Down
 * moved a visual highlight, but the input carried none of the combobox wiring,
 * so a screen reader could not follow the active option. Verifies the input is
 * role="combobox" with aria-controls/aria-autocomplete, aria-expanded tracks
 * the actually-rendered listbox, and aria-activedescendant points at the
 * active option's id as the user arrows through suggestions.
 *
 * Mirrors search-autocomplete-pending.test.tsx (next/navigation + react
 * useTransition mocks; the suggest fetch is stubbed).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
const h = vi.hoisted(() => ({ pending: false }));
vi.mock("react", async (orig) => {
  const actual = (await orig()) as typeof import("react");
  return { ...actual, useTransition: () => [h.pending, (cb: () => void) => cb()] };
});

import { SearchAutocomplete } from "@/components/search/autocomplete";

const SUGGESTIONS = [
  { kind: "scholar", label: "Jane Doe", href: "/jane-doe" },
  { kind: "topic", label: "Oncology", href: "/topics/oncology" },
];

function stubSuggest(suggestions: unknown[]) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ suggestions }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  h.pending = false;
  pushMock.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("SearchAutocomplete — combobox ARIA contract (#review-0707)", () => {
  it("input is a combobox wired to the listbox, collapsed by default", () => {
    stubSuggest([]);
    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    const listboxId = input.getAttribute("aria-controls");
    expect(listboxId).toBeTruthy();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("aria-expanded flips true and options carry ids referencing the listbox once open", async () => {
    stubSuggest(SUGGESTIONS);
    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "on" } });

    const listbox = await screen.findByRole("listbox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const listboxId = input.getAttribute("aria-controls");
    expect(listbox.id).toBe(listboxId);

    const options = screen.getAllByRole("option");
    expect(options[0].id).toBe(`${listboxId}-opt-0`);
    expect(options[1].id).toBe(`${listboxId}-opt-1`);
  });

  it("ArrowDown moves aria-activedescendant to the active option's id", async () => {
    stubSuggest(SUGGESTIONS);
    render(<SearchAutocomplete />);
    const input = screen.getByLabelText("Search scholars");
    fireEvent.change(input, { target: { value: "on" } });
    await screen.findByRole("listbox");

    const listboxId = input.getAttribute("aria-controls");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() =>
      expect(input.getAttribute("aria-activedescendant")).toBe(`${listboxId}-opt-0`),
    );
  });
});
