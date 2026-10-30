/**
 * `components/edit/core-staff-panel.tsx`: paste-CWID add and per-row remove
 * call `/api/edit/core-staff` and refresh the server page. Queries are scoped
 * to the rendered component. Fake CWIDs and names only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: mockRefresh }),
}));

// The directory typeahead is mocked to a button that picks one fake person.
vi.mock("@/components/edit/directory-people-typeahead", () => ({
  DirectoryPeopleTypeahead: ({
    onChange,
    scholarsOnly,
  }: {
    onChange: (v: { cwid: string; name: string; title: string | null }) => void;
    scholarsOnly?: boolean;
  }) => (
    <button
      type="button"
      data-scholars-only={scholarsOnly ? "1" : "0"}
      onClick={() => onChange({ cwid: "pck0001", name: "Picked Person", title: null })}
    >
      pick person
    </button>
  ),
}));

import { CoreStaffPanel } from "@/components/edit/core-staff-panel";

const ROW = {
  cwid: "abc1234",
  name: "Test Staffer",
  slug: "test-staffer",
  affiliation: "Radiology",
  addedAt: new Date("2026-10-01T12:00:00Z"),
  addedBy: "own0001",
  addedByName: "Test Owner",
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  mockRefresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderPanel(staff = [ROW]) {
  const { container } = render(<CoreStaffPanel coreId="2" staff={staff} />);
  return within(container);
}

describe("CoreStaffPanel", () => {
  it("lists staff with name, cwid and provenance", () => {
    const view = renderPanel();
    expect(view.getByRole("link", { name: "Test Staffer" }).getAttribute("href")).toBe(
      "/test-staffer",
    );
    expect(view.getByText("abc1234")).toBeTruthy();
    expect(view.getByText(/added by Test Owner \(own0001\)/)).toBeTruthy();
  });

  it("adds pasted CWIDs, reports the outcome, and refreshes", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, added: ["xyz5678"], alreadyPresent: ["abc1234"], invalid: [] }),
        { status: 200 },
      ),
    );
    const view = renderPanel();
    fireEvent.change(view.getByLabelText("Or paste CWIDs"), {
      target: { value: "xyz5678, ABC1234 oops!" },
    });
    fireEvent.click(view.getByRole("button", { name: "Add staff" }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/core-staff");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", cwids: ["xyz5678", "abc1234"] });
    expect(view.getByRole("status").textContent).toBe(
      "Added 1. Already listed: abc1234. Not a CWID: oops!.",
    );
  });

  it("a directory pick POSTs the picked cwid (not scholars-only) and refreshes", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, added: ["pck0001"], alreadyPresent: [], invalid: [] }),
        { status: 200 },
      ),
    );
    const view = renderPanel([]);
    expect(view.getByText("Add staff by name")).toBeTruthy();
    const pick = view.getByRole("button", { name: "pick person" });
    expect(pick.getAttribute("data-scholars-only")).toBe("0");
    fireEvent.click(pick);
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit/core-staff");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", cwids: ["pck0001"] });
    expect(view.getByRole("status").textContent).toBe("Added 1.");
  });

  it("never posts a paste with no valid CWID", () => {
    const view = renderPanel([]);
    fireEvent.change(view.getByLabelText("Or paste CWIDs"), { target: { value: "nope!" } });
    fireEvent.click(view.getByRole("button", { name: "Add staff" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.getByRole("status").textContent).toContain("No valid CWIDs found");
  });

  it("removes a row by cwid and refreshes; a failed remove re-enables the button", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const view = renderPanel();
    const button = view.getByRole("button", { name: "Remove Test Staffer" });
    fireEvent.click(button);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Could not remove"));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(mockRefresh).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, removed: true })));
    fireEvent.click(button);
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[1];
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ coreId: "2", cwid: "abc1234" });
    expect(button.textContent).toBe("Removed");
  });
});
