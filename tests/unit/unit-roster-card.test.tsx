/**
 * `components/edit/unit-roster-card.tsx` — the simple add/remove member list
 * (#540 Phase 7 § 3, PR-7c). Add/Remove POST /api/edit/roster; the list updates
 * optimistically. The directory typeahead is mocked to a deterministic stub.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/edit/directory-people-typeahead", () => ({
  DirectoryPeopleTypeahead: ({
    value,
    onChange,
  }: {
    value: { cwid: string; name: string } | null;
    onChange: (v: { cwid: string; name: string; title: string | null } | null) => void;
  }) =>
    value ? (
      <span data-testid="picked">{value.name}</span>
    ) : (
      <button
        type="button"
        data-testid="typeahead-pick"
        onClick={() => onChange({ cwid: "pick9", name: "Picked Person", title: "MD" })}
      >
        pick
      </button>
    ),
}));

import { UnitRosterCard } from "@/components/edit/unit-roster-card";

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubOk() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: true, changed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

function stubErr(status: number, error: string) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

const base = { entityType: "division" as const, unitCode: "N9001" };

describe("UnitRosterCard", () => {
  it("shows the empty state with no members", () => {
    render(<UnitRosterCard {...base} members={[]} />);
    expect(screen.getByTestId("unit-roster-empty")).toBeTruthy();
  });

  it("lists existing members with name and title", () => {
    render(<UnitRosterCard {...base} members={[{ cwid: "m1", name: "Existing One", title: "PhD" }]} />);
    expect(screen.getByTestId("unit-roster-row-m1")).toBeTruthy();
    expect(screen.getByText("Existing One")).toBeTruthy();
  });

  it("Add POSTs action:add with the picked cwid and inserts the row", async () => {
    const fetchMock = stubOk();
    render(<UnitRosterCard {...base} members={[]} />);
    fireEvent.click(screen.getByTestId("typeahead-pick"));
    fireEvent.click(screen.getByTestId("unit-roster-add"));
    await waitFor(() => expect(screen.getByTestId("unit-roster-row-pick9")).toBeTruthy());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/roster");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ unitType: "division", unitCode: "N9001", cwid: "pick9", action: "add" });
  });

  it("reverts the optimistic insert when Add fails", async () => {
    stubErr(403, "not_curator");
    render(<UnitRosterCard {...base} members={[]} />);
    fireEvent.click(screen.getByTestId("typeahead-pick"));
    fireEvent.click(screen.getByTestId("unit-roster-add"));
    await waitFor(() => expect(screen.getByText(/no longer have access/i)).toBeTruthy());
    expect(screen.queryByTestId("unit-roster-row-pick9")).toBeNull();
  });

  it("Remove confirms then POSTs action:remove and drops the row", async () => {
    const fetchMock = stubOk();
    render(<UnitRosterCard {...base} members={[{ cwid: "m1", name: "Existing One", title: "PhD" }]} />);
    fireEvent.click(screen.getByTestId("unit-roster-remove-m1"));
    const confirmButtons = screen.getAllByRole("button", { name: "Remove" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(screen.queryByTestId("unit-roster-row-m1")).toBeNull());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ unitType: "division", unitCode: "N9001", cwid: "m1", action: "remove" });
  });
});
