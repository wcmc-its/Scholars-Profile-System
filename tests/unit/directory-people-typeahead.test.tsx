/**
 * `components/edit/directory-people-typeahead.tsx` — debounced search, result
 * rendering, selection, the selected-chip + clear, and the error state
 * (#540 Phase 7 § 7). Fake timers drive the 300 ms debounce.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { DirectoryPeopleTypeahead } from "@/components/edit/directory-people-typeahead";

/** Advance the debounce + flush the fetch/`setState` microtasks inside act(). */
async function settle(ms = 350) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const PERSON = { cwid: "abc123", name: "Ada Lovelace", title: "Professor", dept: "CS" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stubOk(people: unknown[]) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, people }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("DirectoryPeopleTypeahead — search", () => {
  it("does not fetch for a query shorter than 2 characters", async () => {
    const fetchMock = stubOk([PERSON]);
    render(<DirectoryPeopleTypeahead value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId("directory-input"), { target: { value: "a" } });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("debounces, fetches, and renders matches", async () => {
    const fetchMock = stubOk([PERSON]);
    render(<DirectoryPeopleTypeahead value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId("directory-input"), { target: { value: "ada" } });
    await settle();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/directory/people?q=ada",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(screen.getByTestId("directory-option-abc123")).toBeTruthy();
  });

  it("selecting a result calls onChange with the picked value", async () => {
    stubOk([PERSON]);
    const onChange = vi.fn();
    render(<DirectoryPeopleTypeahead value={null} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("directory-input"), { target: { value: "ada" } });
    await settle();
    fireEvent.mouseDown(screen.getByTestId("directory-option-abc123"));
    expect(onChange).toHaveBeenCalledWith({ cwid: "abc123", name: "Ada Lovelace", title: "Professor" });
  });

  it("renders a failure state when the fetch is not ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "directory_unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<DirectoryPeopleTypeahead value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId("directory-input"), { target: { value: "ada" } });
    await settle();
    expect(screen.getByText("Search failed")).toBeTruthy();
  });
});

describe("DirectoryPeopleTypeahead — selected state", () => {
  it("renders a chip and clears via the × button", () => {
    const onChange = vi.fn();
    render(
      <DirectoryPeopleTypeahead
        value={{ cwid: "abc123", name: "Ada Lovelace", title: "Professor" }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.queryByTestId("directory-input")).toBeNull();
    fireEvent.click(screen.getByTestId("directory-clear"));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
